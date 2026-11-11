// #56: the 404 a create's checkQueue gets for a missing queue is expected (the pool then declares
// it), so it is an 'info'. A 404 anywhere else still reaches 'error'.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');
const { MGMT, mgmt, until, queuePath, connectionNamed, closeConnection } = require('./helpers/mgmt');

// like amqplib: a refused passive check closes the channel, which emits 'error' (code 404)
// before the pending promise's handlers run
function notFound() {
  return Object.assign(new Error('Operation failed: QueueDeclare; 404 (NOT-FOUND)'), { code: 404 });
}
class ClosingChannel extends FakeAmqpChannel {
  constructor() { super(); this.strictQueues = true; }
  checkQueue(queue) {
    if (this.queues.has(queue)) return Promise.resolve({ queue });
    const err = notFound();
    this.emit('error', err);
    return Promise.reject(err);
  }
}

function setup(config, tune = () => {}) {
  const made = [];
  const connection = {
    alive: true, url: 'amqp://u:p@rabbit.example:5672',
    amqpConnection: {
      createConfirmChannel: () => {
        const c = new ClosingChannel();
        tune(c);
        made.push(c);
        return Promise.resolve(c);
      },
    },
  };
  const channel = new Channel(connection, config);
  const errors = [];
  const infos = [];
  channel.on('error', e => errors.push(e));
  channel.on('info', i => infos.push(i));
  return { channel, made, errors, infos, last: () => made[made.length - 1] };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const named = () => ({ exchange: { name: 'events' }, queue: { name: 'work' } });
const dynamic = () => ({ exchange: { name: 'events' }, binding: { enabled: true }, prefetch: 1 });

test('a first declare of a missing named queue emits no error and is declared', async () => {
  const { channel, errors, infos, last } = setup(named());
  const up = new Promise(r => channel.once('ready', r));
  channel.create();
  await up;
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(last().asserted.queue, 'work');
  assert.ok(infos.some(i => i?.message === 'queue not found, declaring it' && i.queue === 'work'));
});

test('a re-create of a dynamic queue the broker lost emits no error and consumes again', async () => {
  const { channel, errors, last } = setup(dynamic());
  const up = new Promise(r => channel.once('ready', r));
  channel.create();
  await up;
  channel.consume();
  await settle();
  const name = channel.queue.name;
  assert.ok(name.endsWith(`:${os.hostname}`));
  // a new connection: the exclusive queue went with the old one, the new fake does not know it
  const again = new Promise(r => channel.once('recreated', r));
  channel.create();
  await again;
  await settle();
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(last().asserted.queue, name);
  assert.strictEqual(last().consumers.length, 1);
});

test('a 404 on a channel with no check in flight is an error', async () => {
  const { channel, errors, last } = setup(named(), c => c.queues.add('work'));
  const up = new Promise(r => channel.once('ready', r));
  channel.create();
  await up;
  last().emit('error', notFound());
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].code, 404);
});

test('a second 404 after the check settled is an error: the exemption is the one check', async () => {
  const { channel, errors, last } = setup(named());
  const up = new Promise(r => channel.once('ready', r));
  channel.create();
  await up;
  await settle();
  assert.deepStrictEqual(errors, []);
  last().emit('error', notFound());   // e.g. a publish to a deleted queue
  assert.strictEqual(errors.length, 1);
});

test('one create holding the expected 404 and a refused bind: only the bind is an error', async () => {
  const { channel, errors } = setup({ ...named(), binding: { enabled: true } }, c => {
    c.bindQueue = () => { const e = notFound(); c.emit('error', e); return Promise.reject(e); };
  });
  channel.create();
  await settle();
  await settle();
  assert.ok(errors.length >= 1, 'the refused bind reached error');
  assert.ok(errors.every(e => e?.message !== 'queue not found, declaring it'));
  // one 404 per failed create: the create's own 'cant establish a channel', not the check's
  assert.strictEqual(errors.filter(e => e?.err?.code === 404).length, errors.length);
});

test('a check that fails with another code is an error', async () => {
  const { channel, errors } = setup(named(), c => {
    c.checkQueue = () => {
      const e = Object.assign(new Error('ACCESS_REFUSED'), { code: 403 });
      c.emit('error', e);
      return Promise.reject(e);
    };
  });
  channel.create();
  await settle();
  assert.ok(errors.some(e => e?.message === 'cant establish a channel' && e.err?.code === 403));
});

// ---- live broker: no queue created beforehand

const URL_ = process.env.FAMQP_TEST_URL;
const skipLive = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;
let seq = 0;
const unique = what => `famqp-d404-${what}-${process.pid}-${Date.now()}-${seq++}`;

async function livePool(t, channelConf) {
  const amqplib = require('amqplib');
  const AMQPPool = require('..');
  const u = new URL(URL_);
  const exchange = unique('x');
  const connection_name = unique('conn');
  const admin = await amqplib.connect(URL_);
  const adminCh = await admin.createChannel();
  adminCh.on('error', () => {});
  const queues = [];
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50, connection_name },
    channel: { exchange: { name: exchange, type: 'fanout' }, binding: { enabled: true },
      ...channelConf },
  }]);
  const errors = [];
  pool.on('error', e => errors.push(e));
  t.after(async () => {
    const stopped = pool.stop();
    pool.on('error', () => {});
    await stopped.catch(() => {});
    // one fresh channel per delete: a refused delete (an exclusive queue held by its connection)
    // closes its channel, which must not stop the deletes after it or leave the process alive
    const drop = async (kind, name) => {
      try {
        const c = await admin.createChannel();
        c.on('error', () => {});
        await c[kind](name).catch(() => {});
        await c.close().catch(() => {});
      } catch (e) {} // the admin connection is gone
    };
    for (const q of queues) await drop('deleteQueue', q);
    await drop('deleteExchange', exchange);
    await admin.close().catch(() => {});
  });
  return { pool, adminCh, exchange, errors, queues, connectionName: `${connection_name}_${os.hostname}` };
}
function waitEvent(emitter, event, test = () => true) {
  let got;
  const f = arg => { if (got === undefined && test(arg)) got = arg ?? true; };
  emitter.on(event, f);
  const found = until(() => got, `'${event}'`, 90).finally(() => emitter.off(event, f));
  found.catch(() => {});
  return found;
}
const consuming = ch => waitEvent(ch, 'info', i => i?.message?.startsWith?.('consume from queue'));

test('live: a dynamic queue reconnect emits no error and consumes again',
  { skip: skipLive }, async t => {
  const { pool, adminCh, exchange, errors, queues, connectionName } = await livePool(t, { prefetch: 1 });
  const ch = await waitEvent(pool, 'ready');
  const bodies = [];
  ch.on('message', m => { bodies.push(m.content.toString()); ch.ack(m); });
  const done = consuming(ch);
  ch.consume();
  await done;
  // the dynamic queue is exclusive: it goes with its connection
  t.after(() => mgmt('DELETE', queuePath(ch.queue.name)));
  assert.deepStrictEqual(errors, []);
  const recreated = waitEvent(pool, 'recreated');
  await closeConnection(await connectionNamed(connectionName));
  await recreated;
  for (let i = 0; i < 40 && !bodies.includes('after'); i++) {
    adminCh.publish(exchange, '', Buffer.from('after'));
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(bodies.includes('after'), 'the re-created queue delivered');
  assert.deepStrictEqual(errors, [], 'no error event on the reconnect');
});

test('live: a first declare of a missing named queue emits no error',
  { skip: skipLive }, async t => {
  const name = unique('named');
  const { pool, errors, queues } = await livePool(t, { prefetch: 5, queue: { name } });
  queues.push(name);
  await waitEvent(pool, 'ready');
  assert.ok(await until(() => mgmt('GET', queuePath(name)), `queue ${name}`), 'declared');
  assert.deepStrictEqual(errors, []);
});

test('live: a 404 outside the create path still emits error',
  { skip: skipLive }, async t => {
  const { pool, errors } = await livePool(t, { prefetch: 5 });   // no queue: no create-path check
  const ch = await waitEvent(pool, 'ready');
  assert.deepStrictEqual(errors, []);
  // a passive check of a missing queue on the live channel closes it with a 404
  await ch.amqpChannel.checkQueue(unique('missing')).catch(() => {});
  await until(() => errors.some(e => e?.code === 404), 'a 404 error event', 50);
});
