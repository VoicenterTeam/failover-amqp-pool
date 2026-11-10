// A closed Channel stays closed, and removeChannelById resolves for a dead channel (issue #8).
// No broker except the last block (FAMQP_TEST_URL): amqplib.connect and createConfirmChannel are
// faked, timers are node:test mock timers, nothing sleeps.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const AMQPPool = require('..');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');
const { startMetrics } = require('./helpers/otel');

const flush = () => new Promise(setImmediate);
const INTERVAL = 10;
const CONFIG = { queue: { name: 'q' }, prefetch: 1 };

// The amqplib channel as 2.x behaves: close() answers, then 'close' arrives; close() on a channel
// that is already closed rejects. Switches: rejectClose (close() always rejects, no 'close'),
// deferClose (close() answers, 'close' waits for finishClose()), holdCheck (checkQueue waits).
class ClosingChannel extends FakeAmqpChannel {
  constructor() {
    super();
    this.closeCalls = 0;
    this.closed = false;
    this.rejectClose = false;
    this.deferClose = false;
    this.holdCheck = null;
  }
  close() {
    this.closeCalls++;
    if (this.closed || this.rejectClose) return Promise.reject(new Error('Channel closed'));
    this.closed = true;
    if (!this.deferClose) Promise.resolve().then(() => this.emit('close'));
    return Promise.resolve();
  }
  finishClose() { this.emit('close'); }
  brokerClose() { this.closed = true; this.emit('close'); }
  checkQueue(queue) {
    if (!this.holdCheck) return super.checkQueue(queue);
    return new Promise(resolve => this.holdCheck.push(() => resolve({ queue })));
  }
}

// An amqplib connection that makes ClosingChannels; `hold` parks createConfirmChannel until the
// test releases or fails it. `onNew` prepares each new channel.
function fakeAmqpConnection() {
  const c = new EventEmitter();
  c.creates = 0;
  c.made = [];
  c.held = [];
  c.hold = false;
  c.onNew = () => {};
  c.createConfirmChannel = () => {
    c.creates++;
    const make = () => {
      const ch = new ClosingChannel();
      c.onNew(ch);
      c.made.push(ch);
      return ch;
    };
    if (!c.hold) return Promise.resolve(make());
    return new Promise((resolve, reject) =>
      c.held.push({ release: () => resolve(make()), reject }));
  };
  c.close = () => { Promise.resolve().then(() => c.emit('close')); return Promise.resolve(); };
  return c;
}

// One Channel on a stand-in connection that is up.
function channelRig(config = CONFIG) {
  const amqp = fakeAmqpConnection();
  const connection = { alive: true, url: 'amqp://rabbit.example:5672', config: {},
    reconnectInterval: INTERVAL, amqpConnection: amqp };
  const channel = new Channel(connection, config);
  const events = [];
  const errors = [];
  channel.on('error', error => errors.push(error));
  for (const name of ['ready', 'recreated']) channel.on(name, () => events.push(name));
  return { channel, amqp, events, errors, fake: () => amqp.made[amqp.made.length - 1] };
}

async function readyRig(config) {
  const rig = channelRig(config);
  const ready = new Promise(resolve => rig.channel.once('ready', resolve));
  rig.channel.create();
  await ready;
  return rig;
}

// A pool on faked connections: every amqplib.connect opens one, `refuse` refuses them all.
function poolRig(t, { mockTimers = true, refuse = false, channels } = {}) {
  if (mockTimers) t.mock.timers.enable({ apis: ['setTimeout'] });
  const opened = [];
  t.mock.method(amqplib, 'connect', () => {
    if (refuse) return Promise.reject(new Error('connect ECONNREFUSED'));
    const c = fakeAmqpConnection();
    opened.push(c);
    return Promise.resolve(c);
  });
  const sigint = process.listeners('SIGINT');
  const pool = new AMQPPool([{ connection: { host: 'rabbit.example', port: 5672,
    reconnectInterval: INTERVAL }, ...(channels ? { channels } : { channel: CONFIG }) }]);
  const events = [];
  pool.on('error', () => {});
  for (const name of ['ready', 'recreated']) pool.on(name, () => events.push(name));
  t.after(async () => {
    await pool.stop();
    for (const l of process.listeners('SIGINT')) if (!sigint.includes(l)) process.off('SIGINT', l);
  });
  return { pool, opened, events, channel: () => pool.getAllChannels()[0] };
}

async function readyPool(t, options) {
  const rig = poolRig(t, options);
  await flush();
  return rig;
}

// Whether a promise has settled once the queued callbacks ran.
async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await flush();
  return done;
}

async function tick(t, ms) {
  t.mock.timers.tick(ms);
  await flush();
}

// ---- a closed channel is not re-created by a read ----

test('close() then an alive read: createConfirmChannel is not called again', async () => {
  const { channel, amqp } = await readyRig();
  channel.close();
  await flush();
  assert.strictEqual(amqp.creates, 1);
  assert.strictEqual(channel.alive, false);
  assert.strictEqual(channel.isAlive, false);
  assert.strictEqual(amqp.creates, 1, 'the read re-created nothing');
});

// every public entry that reads `alive`: none of them brings a closed channel back
test('on a closed channel, publish, consume, ack and nack re-create nothing', async t => {
  const { channel, amqp, fake } = await readyRig();
  const message = { content: Buffer.from('m'), fields: { deliveryTag: 1 }, properties: {} };
  channel.close();
  await flush();
  const rows = {
    publish: () => assert.throws(() => channel.publish('x'), Error),
    consume: () => channel.consume(),
    ack: () => channel.ack(message),
    nack: () => channel.nack(message),
  };
  for (const [name, call] of Object.entries(rows)) {
    await t.test(name, async () => {
      call();
      await flush();
      assert.strictEqual(amqp.creates, 1, `${name} re-created the channel`);
      assert.deepStrictEqual(fake().published, []);
    });
  }
});

test('create() on a closed channel does nothing', async () => {
  const { channel, amqp } = await readyRig();
  channel.close();
  await flush();
  channel.create();
  await flush();
  assert.strictEqual(amqp.creates, 1);
});

test('close() then pool.publish: no re-create, the message is cached', async t => {
  const { pool, opened, events, channel } = await readyPool(t);
  assert.strictEqual(opened[0].creates, 1);
  channel().close();
  await flush();
  pool.publish({ a: 1 });
  await flush();
  assert.strictEqual(opened[0].creates, 1, 'the publish re-created the channel');
  assert.strictEqual(pool.msgCache.length, 1);
  assert.deepStrictEqual(events, ['ready']);
});

test('close() twice closes the amqplib channel once', async () => {
  const { channel, fake } = await readyRig();
  channel.close();
  channel.close();
  await flush();
  assert.strictEqual(fake().closeCalls, 1);
});

// ---- a closed channel is not re-created by a create in flight or a timer ----

test('close() during an in-flight create: the new amqplib channel closes, no ready', async () => {
  const { channel, amqp, events } = channelRig();
  amqp.hold = true;
  channel.create();
  channel.close();
  amqp.held[0].release();
  await flush();
  assert.strictEqual(amqp.made[0].closeCalls, 1, 'the late amqplib channel stays open');
  assert.deepStrictEqual(events, []);
  assert.strictEqual(channel.isAlive, false);
});

test('close() while a create waits on the queue check: channel closes, no ready', async () => {
  const { channel, amqp, events } = channelRig();
  amqp.onNew = ch => { ch.holdCheck = []; };
  channel.create();
  await flush();
  channel.close();
  amqp.made[0].holdCheck.forEach(release => release());
  await flush();
  assert.strictEqual(amqp.made[0].closeCalls, 1);
  assert.deepStrictEqual(events, []);
  assert.strictEqual(channel.isAlive, false);
});

// a failed create schedules its retry; the control channel shows the timer exists
test('a create-retry timer pending at close() creates nothing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows = { 'closed': 1, 'never closed (control)': 2 };
  for (const [name, creates] of Object.entries(rows)) {
    await t.test(name, async () => {
      const { channel, amqp } = channelRig();
      amqp.hold = true;
      channel.create();
      amqp.held[0].reject(new Error('refused'));
      await flush();
      if (name === 'closed') channel.close();
      await tick(t, INTERVAL);
      assert.strictEqual(amqp.creates, creates);
    });
  }
});

test('close() during a create that then fails schedules no retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel, amqp, errors } = channelRig();
  amqp.hold = true;
  channel.create();
  channel.close();
  amqp.held[0].reject(new Error('refused'));
  await flush();
  for (let i = 0; i < 3; i++) await tick(t, INTERVAL);
  assert.strictEqual(amqp.creates, 1);
  assert.deepStrictEqual(errors, [], 'a create cut short by close() reported an error');
});

// ---- a closed channel is not re-created when its connection reconnects ----

async function reconnect(t, { close }) {
  const rig = await readyPool(t);
  if (close) rig.channel().close();
  await flush();
  rig.opened[0].emit('close');        // the connection drops
  await tick(t, INTERVAL);            // its retry connects again and re-creates its channels
  return rig;
}

test('close() then the connection reconnects: the closed channel is not re-created', async t => {
  const { opened, events } = await reconnect(t, { close: true });
  assert.strictEqual(opened.length, 2, 'the connection came back');
  assert.strictEqual(opened[1].creates, 0);
  assert.deepStrictEqual(events, ['ready']);
});

test('a channel never closed is re-created when its connection reconnects', async t => {
  const { opened, events } = await reconnect(t, { close: false });
  assert.strictEqual(opened.length, 2);
  assert.strictEqual(opened[1].creates, 1);
  assert.deepStrictEqual(events, ['ready', 'recreated']);
});

// ---- unchanged: a channel never closed re-creates, ready once, recreated after ----

test('after a broker-side close an alive read re-creates; ready once, then recreated', async () => {
  const { channel, amqp, events, fake } = await readyRig();
  fake().brokerClose();
  assert.strictEqual(channel.isAlive, false);
  const read = channel.alive;         // the read starts the create
  await flush();
  assert.strictEqual(read, false);
  assert.strictEqual(amqp.creates, 2);
  assert.strictEqual(channel.isAlive, true);
  assert.deepStrictEqual(events, ['ready', 'recreated']);
});

test('ack and nack of a message from a replaced amqplib channel are still dropped', async t => {
  const { channel, fake, amqp } = await readyRig();
  channel.consume();
  const stale = fake().deliver('old');
  fake().brokerClose();
  channel.alive;
  await flush();
  channel.consume();
  const current = fake().deliver('new');
  assert.strictEqual(amqp.creates, 2);
  const ack = t.mock.method(fake(), 'ack');
  const nack = t.mock.method(fake(), 'nack');
  channel.ack(stale);
  channel.nack(stale);
  const settled = ack.mock.callCount() + nack.mock.callCount();
  assert.strictEqual(settled, 0, 'a stale tag reached the new channel');
  channel.ack(current);
  channel.nack(current);
  assert.strictEqual(ack.mock.callCount(), 1);
  assert.strictEqual(nack.mock.callCount(), 1);
});

// ---- removeChannelById ----

test('removeChannelById on a dead channel resolves and the channel is gone', async t => {
  const rows = {
    'the broker closed its channel': async t2 => {
      const rig = await readyPool(t2);
      rig.opened[0].made[0].brokerClose();
      return rig;
    },
    'it was never created (connection down)': t2 => readyPool(t2, { refuse: true }),
  };
  for (const [name, setup] of Object.entries(rows)) {
    await t.test(name, async t2 => {
      const { pool, channel } = await setup(t2);
      const id = channel()._id;
      const removed = pool.removeChannelById(id);
      assert.strictEqual(await settled(removed), true, 'removeChannelById is still waiting');
      assert.deepStrictEqual(pool.getAllChannels(), []);
    });
  }
});

test('removeChannelById on a live channel resolves after the close, channel gone', async t => {
  const { pool, opened, channel } = await readyPool(t);
  const fake = opened[0].made[0];
  fake.deferClose = true;
  const removed = pool.removeChannelById(channel()._id);
  assert.strictEqual(await settled(removed), false, 'resolved before the close event');
  assert.strictEqual(pool.getAllChannels().length, 1, 'removed before the close event');
  fake.finishClose();
  assert.strictEqual(await settled(removed), true);
  assert.deepStrictEqual(pool.getAllChannels(), []);
  assert.strictEqual(fake.closeCalls, 1);
});

test('removeChannelById resolves when amqpChannel.close() rejects', async t => {
  const { pool, opened, channel } = await readyPool(t);
  const fake = opened[0].made[0];
  fake.rejectClose = true;   // amqplib 2 rejects close() on a channel that is already closed
  const removed = pool.removeChannelById(channel()._id);
  assert.strictEqual(await settled(removed), true, 'removeChannelById is still waiting');
  assert.deepStrictEqual(pool.getAllChannels(), []);
});

// ---- telemetry: down until removed, then not counted ----

// two channels: a pool with none left reports no observation, and the SDK keeps the last value
test('a closed channel counts as down in amqp_pool.channel.count until it is removed', async t => {
  const { points } = startMetrics(t);
  const channels = [{ queue: { name: 'a' } }, { queue: { name: 'b' } }];
  const { pool, channel } = await readyPool(t, { mockTimers: false, channels });
  const count = async () => {
    const byState = { alive: 0, down: 0 };
    for (const p of await points('amqp_pool.channel.count')) {
      byState[p.attributes['amqp_pool.state']] += p.value;
    }
    return byState;
  };
  assert.deepStrictEqual(await count(), { alive: 2, down: 0 });
  const id = channel()._id;
  channel().close();
  await flush();
  assert.deepStrictEqual(await count(), { alive: 1, down: 1 }, 'closed, still in the pool');
  const removed = pool.removeChannelById(id);
  assert.strictEqual(await settled(removed), true, 'removeChannelById is still waiting');
  assert.deepStrictEqual(await count(), { alive: 1, down: 0 }, 'removed');
});

// ---- a live broker: the lesson from the fakes of an earlier round ----

const URL_ = process.env.FAMQP_TEST_URL;
const skip = URL_ ? false : 'FAMQP_TEST_URL not set';

async function until(condition, ms = 5000) {
  const end = Date.now() + ms;
  while (!await condition()) {
    if (Date.now() > end) throw new Error('timed out');
    await flush();
  }
}

// A pool consuming from its own queue; `consumers()` is the broker's own count for that queue.
async function livePool(t) {
  const u = new URL(URL_);
  const queue = `famqp-chclose-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const admin = await amqplib.connect(URL_);
  const adminCh = await admin.createChannel();
  await adminCh.assertQueue(queue, { durable: false, autoDelete: false });
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50 },
    channel: { prefetch: 5, queue: { name: queue } } }]);
  pool.on('error', () => {});
  const infos = [];
  pool.on('info', i => infos.push(i));
  pool.on('ready', ch => ch.consume());
  t.after(async () => {
    await adminCh.deleteQueue(queue).catch(() => {});
    await admin.close().catch(() => {});
    const stopped = pool.stop();
    pool.on('error', () => {});
    await stopped.catch(() => {});
  });
  const consumers = async () => (await adminCh.checkQueue(queue)).consumerCount;
  const created = () => infos.filter(i => i?.message === 'channel created').length;
  await until(async () => created() === 1 && await consumers() === 1);
  const connection = pool.connections[0];
  const calls = { n: 0 };
  const create = connection.amqpConnection.createConfirmChannel.bind(connection.amqpConnection);
  connection.amqpConnection.createConfirmChannel = (...args) => {
    calls.n++;
    return create(...args);
  };
  return { pool, consumers, created, calls };
}

test('live: removeChannelById ends the consumer, a publish makes no channel', { skip }, async t => {
  const { pool, consumers, created, calls } = await livePool(t);
  const channel = pool.getAllChannels()[0];
  await pool.removeChannelById(channel._id);
  await until(async () => await consumers() === 0);
  assert.deepStrictEqual(pool.getAllChannels(), []);
  pool.publish('after-removal');
  assert.strictEqual(calls.n, 0, 'the publish created a channel');
  assert.strictEqual(pool.msgCache.length, 1);
  assert.strictEqual(created(), 1);
});

test('live: a closed channel left in the pool is not re-created by publish', { skip }, async t => {
  const { pool, consumers, created, calls } = await livePool(t);
  const channel = pool.getAllChannels()[0];
  channel.close();
  await until(async () => await consumers() === 0);
  pool.publish('after-close');
  assert.strictEqual(calls.n, 0, 'the publish created a channel');
  assert.strictEqual(pool.msgCache.length, 1);
  assert.strictEqual(created(), 1);
  assert.strictEqual(await consumers(), 0);
});
