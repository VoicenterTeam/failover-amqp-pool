// A stopped pool stays stopped: disconnect() and stop() end every retry, every late connect and
// every teardown error. No broker: amqplib.connect is mocked, timers are node:test mock timers.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const AMQPPool = require('..');
const Connection = require('../Connection');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');

const flush = () => new Promise(setImmediate);
const INTERVAL = 10;

// An amqplib connection that closes the way the real one does: 'close' arrives after close(),
// and close() on a closed connection rejects (amqplib 2.3.1 toClosed(): IllegalOperationError).
function fakeAmqpConnection() {
  const c = new EventEmitter();
  c.closeCalls = 0;
  c.channelCalls = 0;
  c.amqpChannels = [];
  c.deferClose = false;
  c.rejectClose = false;
  c.closed = false;
  c.beforeClose = () => {};
  c.finishClose = () => c.emit('close');
  c.on('close', () => { c.closed = true; });
  c.close = () => {
    c.closeCalls++;
    if (c.closed || c.rejectClose) {
      return Promise.reject(new Error('Connection closed (by server)'));
    }
    c.beforeClose();
    if (!c.deferClose) Promise.resolve().then(c.finishClose);
    return Promise.resolve();
  };
  c.createConfirmChannel = () => {
    c.channelCalls++;
    const ch = new FakeAmqpChannel();
    c.amqpChannels.push(ch);
    return Promise.resolve(ch);
  };
  return c;
}

// amqplib.connect: a url with "down" in it is refused, any other opens a fake.
function mockBroker(t) {
  const opened = [];
  t.mock.method(amqplib, 'connect', url => {
    if (url.includes('down')) return Promise.reject(new Error('connect ECONNREFUSED'));
    const c = fakeAmqpConnection();
    opened.push(c);
    return Promise.resolve(c);
  });
  return opened;
}

// amqplib.connect settles when the test says so.
function mockPendingConnect(t) {
  const pending = [];
  t.mock.method(amqplib, 'connect',
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  return pending;
}

function standalone(t, { onError = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connection = new Connection('amqp://broker.example:5672', { reconnectInterval: INTERVAL });
  if (onError) connection.on('error', () => {});
  connection.on('close', () => {});
  t.after(() => connection.disconnect());
  return connection;
}

// One tick of the clock, then the promise callbacks it released.
async function tick(t, ms) {
  t.mock.timers.tick(ms);
  await flush();
}

function makePool(t, hosts) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pool = new AMQPPool(hosts.map(host => ({
    connection: { host, port: 5672, reconnectInterval: INTERVAL },
    channel: { queue: { name: `lifecycle-${host}` } }
  })));
  pool.on('error', () => {});
  t.after(async () => {
    await pool.stop();
  });
  return pool;
}

// ---- Connection: a failed connect in flight, then disconnect() ----

test('a failed connect in flight when disconnect() is called is not retried', async t => {
  const pending = mockPendingConnect(t);
  const connection = standalone(t);
  connection.start();
  connection.disconnect();
  pending[0].reject(new Error('connect ECONNREFUSED'));
  await flush();
  for (let i = 0; i < 3; i++) await tick(t, INTERVAL);
  assert.strictEqual(amqplib.connect.mock.callCount(), 1);
});

test('a retry timer already pending when disconnect() is called is cleared', async t => {
  const pending = mockPendingConnect(t);
  const connection = standalone(t);
  connection.start();
  pending[0].reject(new Error('connect ECONNREFUSED'));
  await flush();
  connection.disconnect();
  for (let i = 0; i < 3; i++) await tick(t, INTERVAL);
  assert.strictEqual(amqplib.connect.mock.callCount(), 1);
});

test('disconnect() clears the retry timer a failed connect scheduled', async t => {
  const pending = mockPendingConnect(t);
  const connection = standalone(t);
  t.mock.method(globalThis, 'setTimeout');
  t.mock.method(globalThis, 'clearTimeout');
  connection.start();
  pending[0].reject(new Error('connect ECONNREFUSED'));
  await flush();
  const [scheduled] = globalThis.setTimeout.mock.calls;
  connection.disconnect();
  const cleared = globalThis.clearTimeout.mock.calls.map(c => c.arguments[0]);
  assert.ok(cleared.includes(scheduled.result), 'the retry timer is cleared');
});

// ---- Connection: a successful connect in flight, then disconnect() ----

async function lateConnect(t, options) {
  const pending = mockPendingConnect(t);
  const connection = standalone(t, options);
  const channel = new Channel(connection, { queue: { name: 'lifecycle-late' } });
  t.mock.method(channel, 'create');
  connection.addChannel(channel);
  connection.start();
  connection.disconnect();
  const amqp = fakeAmqpConnection();
  pending[0].resolve(amqp);
  await flush();
  return { connection, channel, amqp };
}

test('a connect resolving after disconnect() is closed at once and is not alive', async t => {
  const { connection, amqp } = await lateConnect(t);
  assert.strictEqual(amqp.closeCalls, 1);
  assert.strictEqual(connection.alive, false);
  assert.ok(!connection.amqpConnection, 'the late connection is not kept');
});

test('a connect resolving after disconnect() creates no channel', async t => {
  const { channel, amqp } = await lateConnect(t);
  assert.strictEqual(channel.create.mock.callCount(), 0);
  assert.strictEqual(amqp.channelCalls, 0);
});

test('an error on the late connection after its close is swallowed', async t => {
  const { amqp } = await lateConnect(t, { onError: false });
  assert.doesNotThrow(() => amqp.emit('error', new Error('socket closed')));
});

// ---- Connection: a close with reconnectOnClose false ----

test('a close with reconnectOnClose false schedules no timer', async t => {
  const pending = mockPendingConnect(t);
  const connection = standalone(t);
  connection.start();
  const amqp = fakeAmqpConnection();
  pending[0].resolve(amqp);
  await flush();
  connection.reconnectOnClose = false;
  t.mock.method(globalThis, 'setTimeout');
  amqp.emit('close');
  assert.strictEqual(globalThis.setTimeout.mock.callCount(), 0);
});

// ---- Pool stop() ----

test('stop() with two down connections leaves none', async t => {
  mockBroker(t);
  const pool = makePool(t, ['down1.example', 'down2.example']);
  await flush();
  const connections = [...pool.connections];
  await pool.stop();
  assert.strictEqual(pool.connections.length, 0);
  assert.deepStrictEqual(connections.map(c => c.reconnectOnClose), [false, false]);
});

const mixes = [
  ['down.example', 'up.example'],
  ['up.example', 'down.example'],
  ['up1.example', 'up2.example']
];
for (const hosts of mixes) {
  test(`stop() with [${hosts}] leaves none and disconnects each`, async t => {
    const opened = mockBroker(t);
    const pool = makePool(t, hosts);
    await flush();
    const connections = [...pool.connections];
    t.mock.method(Connection.prototype, 'disconnect');
    await pool.stop();
    assert.strictEqual(pool.connections.length, 0);
    const disconnected = Connection.prototype.disconnect.mock.calls.map(c => c.this);
    assert.deepStrictEqual(disconnected, connections);
    assert.deepStrictEqual(opened.map(c => c.closeCalls), opened.map(() => 1));
  });
}

test('stop() resolves only after the live connection has closed', async t => {
  const opened = mockBroker(t);
  const pool = makePool(t, ['up.example']);
  await flush();
  opened[0].deferClose = true;
  let stopped = false;
  const stopping = pool.stop().then(() => { stopped = true; });
  await flush();
  assert.strictEqual(stopped, false);
  opened[0].finishClose();
  await stopping;
  assert.strictEqual(stopped, true);
});

// ---- A channel error around stop() ----

test('a channel error while stop() closes the connections does not throw', async t => {
  const opened = mockBroker(t);
  const pool = makePool(t, ['up.example']);
  await flush();
  opened[0].beforeClose = () =>
    opened[0].amqpChannels[0].emit('error', new Error('channel error'));
  await assert.doesNotReject(pool.stop());
});

const payloads = [
  ['an Error', new Error('channel error')],
  ['an object', { message: 'channel error' }]
];
for (const [kind, payload] of payloads) {
  test(`a channel error (${kind}) after stop() does not throw`, async t => {
    mockBroker(t);
    const pool = makePool(t, ['up.example']);
    await flush();
    const channel = pool.connections[0].channels[0];
    await pool.stop();
    assert.doesNotThrow(() => channel.emit('error', payload));
  });
}

test('a channel error before stop() with no listener still throws', async t => {
  mockBroker(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pool = new AMQPPool([{
    connection: { host: 'up.example', port: 5672 },
    channel: { queue: { name: 'lifecycle-up' } }
  }]);
  t.after(async () => {
    pool.on('error', () => {});
    await pool.stop();
  });
  await flush();
  const channel = pool.connections[0].channels[0];
  assert.throws(() => channel.emit('error', { message: 'channel error' }),
    { code: 'ERR_UNHANDLED_ERROR' });
});

// ---- Must not change: a connection never disconnected keeps reconnecting ----

test('a failed connect is retried every reconnectInterval while never disconnected', async t => {
  t.mock.method(amqplib, 'connect', () => Promise.reject(new Error('connect ECONNREFUSED')));
  const connection = standalone(t);
  connection.start();
  await flush();
  for (let n = 2; n <= 4; n++) {
    await tick(t, INTERVAL - 1);
    assert.strictEqual(amqplib.connect.mock.callCount(), n - 1, 'not before the interval');
    await tick(t, 1);
    assert.strictEqual(amqplib.connect.mock.callCount(), n);
  }
});

test('a broker-side close is reconnected after reconnectInterval', async t => {
  const opened = [];
  t.mock.method(amqplib, 'connect', () => {
    const c = fakeAmqpConnection();
    opened.push(c);
    return Promise.resolve(c);
  });
  const connection = standalone(t);
  const closes = [];
  connection.on('close', e => closes.push(e));
  connection.start();
  await flush();
  assert.strictEqual(connection.alive, true);
  opened[0].emit('close');
  assert.strictEqual(connection.alive, false);
  assert.strictEqual(closes.length, 1);
  await tick(t, INTERVAL - 1);
  assert.strictEqual(amqplib.connect.mock.callCount(), 1, 'not before the interval');
  await tick(t, 1);
  assert.strictEqual(amqplib.connect.mock.callCount(), 2);
  assert.strictEqual(connection.alive, true);
});

test('a reconnect pending after a close is dropped if reconnectOnClose is cleared', async t => {
  const opened = [];
  t.mock.method(amqplib, 'connect', () => {
    const c = fakeAmqpConnection();
    opened.push(c);
    return Promise.resolve(c);
  });
  const connection = standalone(t);
  connection.start();
  await flush();
  opened[0].emit('close');
  connection.reconnectOnClose = false;
  await tick(t, INTERVAL);
  assert.strictEqual(amqplib.connect.mock.callCount(), 1);
});

// ---- A close() that rejects, as amqplib's does on a connection that is already closed ----

function trackRejections(t) {
  const seen = [];
  const onRejection = e => seen.push(e.message);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  return seen;
}

test('stop() after a broker-side close resolves, rejects nothing, no reconnect', async t => {
  const rejections = trackRejections(t);
  const opened = mockBroker(t);
  const pool = makePool(t, ['up.example']);
  await flush();
  opened[0].emit('close');
  await pool.stop();
  for (let i = 0; i < 3; i++) await flush();
  assert.deepStrictEqual(rejections, []);
  await tick(t, 3 * INTERVAL);
  assert.strictEqual(amqplib.connect.mock.callCount(), 1);
});

test('stop() resolves for a live connection whose close() rejects', async t => {
  const rejections = trackRejections(t);
  const opened = mockBroker(t);
  const pool = makePool(t, ['up.example']);
  await flush();
  opened[0].rejectClose = true;
  let stopped = false;
  const stopping = pool.stop().then(() => { stopped = true; });
  for (let i = 0; i < 3; i++) await flush();
  assert.strictEqual(stopped, true, 'stop() is still waiting for a close that never comes');
  await stopping;
  assert.deepStrictEqual(rejections, []);
  assert.strictEqual(pool.connections.length, 0);
});

// ---- start() after disconnect() ----

test('start() after disconnect() does not connect', async t => {
  t.mock.method(amqplib, 'connect', () => Promise.resolve(fakeAmqpConnection()));
  const connection = standalone(t);
  connection.disconnect();
  connection.start();
  await flush();
  assert.strictEqual(amqplib.connect.mock.callCount(), 0);
  assert.strictEqual(connection.alive, false);
});
