// stop() keeps the app's own listeners and removes only those the pool put on its Connections and
// Channels. A stopped pool emits nothing: the teardown errors that follow are not heard by the
// app (the pool-stops-emitting choice), and do not throw. No broker: amqplib.connect is mocked.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const AMQPPool = require('..');
const { FakeAmqpChannel } = require('./helpers/fakes');

const flush = () => new Promise(setImmediate);

async function livePool(t) {
  t.mock.method(amqplib, 'connect', () => {
    const c = new EventEmitter();
    c.close = () => Promise.resolve().then(() => c.emit('close'));
    c.createConfirmChannel = () => Promise.resolve(new FakeAmqpChannel());
    return Promise.resolve(c);
  });
  const pool = new AMQPPool([{
    connection: { host: 'up.example', port: 5672, reconnectInterval: 60000 },
    channel: { queue: { name: 'stop-listeners' } }
  }]);
  t.after(() => pool.stop());
  await flush();
  const connection = pool.connections[0];
  return { pool, connection, channel: connection.channels[0] };
}

const events = ['info', 'error', 'ready', 'close', 'recreated', 'connection', 'channelMessage'];

test('stop() keeps every listener the app put on the pool', async (t) => {
  const { pool } = await livePool(t);
  const mine = events.map((event) => [event, () => {}]);
  for (const [event, fn] of mine) pool.on(event, fn);
  await pool.stop();
  for (const [event, fn] of mine) {
    assert.deepStrictEqual(pool.rawListeners(event), [fn], `the '${event}' listener`);
  }
});

test('a pool with no listener has none after stop()', async (t) => {
  const { pool } = await livePool(t);
  await pool.stop();
  for (const event of events) assert.strictEqual(pool.listenerCount(event), 0, event);
});

test('an error before stop() reaches the app, one after stop() does not', async (t) => {
  const { pool, channel } = await livePool(t);
  const heard = [];
  pool.on('error', (e) => heard.push(e.message));
  channel.emit('error', new Error('before'));
  await pool.stop();
  assert.doesNotThrow(() => channel.emit('error', new Error('after')));
  assert.deepStrictEqual(heard, ['before']);
});

test('a connection error after stop() is not heard and does not throw', async (t) => {
  const { pool, connection } = await livePool(t);
  const heard = [];
  pool.on('error', (e) => heard.push(e));
  await pool.stop();
  assert.doesNotThrow(() => connection.emit('error', { error: new Error('late') }));
  assert.deepStrictEqual(heard, []);
});

test('a stopped pool forwards no event from its channels or connections', async (t) => {
  const { pool, connection, channel } = await livePool(t);
  const heard = [];
  for (const event of events) pool.on(event, () => heard.push(event));
  await pool.stop();
  for (const event of ['ready', 'recreated', 'close', 'info', 'channelMessage']) {
    channel.emit(event, 'x');
  }
  for (const event of ['close', 'info', 'connection']) connection.emit(event, 'x');
  assert.deepStrictEqual(heard, []);
});

test('a channel taken off the connection before stop() is not forwarded after it', async (t) => {
  const { pool, connection, channel } = await livePool(t);
  const heard = [];
  pool.on('error', (e) => heard.push(e));
  connection.removeChannel(channel);
  await pool.stop();
  channel.emit('error', new Error('late'));
  assert.deepStrictEqual(heard, []);
});

test('stop() twice keeps the app listeners and resolves both', async (t) => {
  const { pool } = await livePool(t);
  const fn = () => {};
  pool.on('info', fn);
  await pool.stop();
  await pool.stop();
  assert.deepStrictEqual(pool.rawListeners('info'), [fn]);
});

// The pool's own emits (not forwarders) are silent after stop() too.
test('a stale ack after stop() emits nothing', async (t) => {
  const { pool, channel } = await livePool(t);
  const heard = [];
  pool.on('info', (m) => heard.push(m));
  await pool.stop();
  assert.doesNotThrow(() => pool.ack({ properties: { channelId: channel._id } }));
  assert.deepStrictEqual(heard, []);
});

test('a publish on a dead channel after stop() emits nothing, and throws without an error listener',
  async (t) => {
    const { pool, channel } = await livePool(t);
    const heard = [];
    pool.on('error', (e) => heard.push(e));
    await pool.stop();
    assert.doesNotThrow(() => pool.publish({ a: 1 }, () => [channel]));
    assert.deepStrictEqual(heard, []);
    pool.removeAllListeners('error');
    assert.doesNotThrow(() => pool.publish({ a: 1 }, () => [channel]));
  });

test('after stop() the channel and the connection keep only their error listener', async (t) => {
  const { pool, connection, channel } = await livePool(t);
  assert.notDeepStrictEqual(channel.eventNames(), ['error']);
  await pool.stop();
  assert.deepStrictEqual(channel.eventNames(), ['error']);
  assert.deepStrictEqual(connection.eventNames(), ['error']);
});

// A stopped pool is final: whatever would open or create something throws.
const final = [
  ['addConnection', (p) => p.addConnection([{ connection: { host: 'b', port: 1 }, channel: {} }])],
  ['createConnection', (p) => p.createConnection('amqp://b:5672', {})],
  ['createChannel', (p) => p.createChannel(0, {})],
  ['start', (p) => p.start()]
];
for (const [name, call] of final) {
  test(`${name}() after stop() throws Pool is stopped and opens nothing`, async (t) => {
    const { pool } = await livePool(t);
    await pool.stop();
    const opened = amqplib.connect.mock.callCount();
    assert.throws(() => call(pool), { message: 'Pool is stopped' });
    assert.strictEqual(amqplib.connect.mock.callCount(), opened);
    assert.strictEqual(pool.connections.length, 0);
  });
}
