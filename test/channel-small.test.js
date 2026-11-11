// Dynamic queues expire (#23), sendToQueue checks its channel and takes options (#27), array
// bindings are awaited (#30). The fakes are local to this file; the live row needs FAMQP_TEST_URL.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const Channel = require('../Channel');
const { startTracing, startMetrics } = require('./helpers/otel');
const { FakeAmqpChannel } = require('./helpers/fakes');

const URL_ = process.env.FAMQP_TEST_URL;
const settle = () => new Promise(resolve => setImmediate(resolve));

// binds are recorded one by one; bindQueue(…, header) is refused when refuse(header) is true
class BindingChannel extends FakeAmqpChannel {
  constructor() {
    super();
    this.binds = [];
    this.pendingBinds = [];
    this.refuse = () => false;
    this.holdBinds = false;
    this.consumed = [];
  }
  bindQueue(queue, exchange, pattern, header) {
    this.binds.push(header);
    if (this.refuse(header)) return Promise.reject(new Error('bind refused'));
    if (!this.holdBinds) return Promise.resolve();
    return new Promise(resolve => this.pendingBinds.push(resolve));
  }
  consume(queue, cb, opts) {
    this.consumed.push(queue);
    return super.consume(queue, cb, opts);
  }
}

async function ready(config, { strict = false } = {}) {
  const amqp = [];
  const connection = {
    alive: true,
    url: 'amqp://user:secret@rabbit.example:5673',
    amqpConnection: {
      createConfirmChannel: () => {
        const c = new BindingChannel();
        c.strictQueues = strict;
        amqp.push(c);
        return Promise.resolve(c);
      },
    },
  };
  const channel = new Channel(connection, config);
  const errors = [];
  channel.on('error', e => errors.push(e));
  const up = new Promise(resolve => channel.once('ready', resolve));
  channel.create();
  await up;
  return { channel, connection, errors, fake: () => amqp[amqp.length - 1] };
}

const dynamic = (options = {}) => ({
  exchange: { name: 'events' }, binding: { enabled: true, pattern: 'rk' }, prefetch: 1,
  queue: { options },
});
const named = (options = {}) => ({
  exchange: { name: 'events' }, prefetch: 1, queue: { name: 'work', options },
});

// ---- #23 the dynamic queue expires; a named queue keeps its options

test('#23 a dynamic queue is asserted with expires 1800000 by default', async () => {
  const { channel, fake } = await ready(dynamic());
  channel.consume();
  await settle();
  assert.strictEqual(fake().asserted.options.expires, 1800000);
});

test('#23 queue.options.expires overrides the default on a dynamic queue', async () => {
  const { channel, fake } = await ready(dynamic({ expires: 60000 }));
  channel.consume();
  await settle();
  assert.strictEqual(fake().asserted.options.expires, 60000);
});

test("#23 expires: 'none' gives a dynamic queue no expires", async () => {
  const { channel, fake } = await ready(dynamic({ expires: 'none' }));
  channel.consume();
  await settle();
  assert.strictEqual(fake().asserted.options.expires, undefined);
});

test('#23 a named queue is asserted with no expires, its own options kept', async () => {
  const { fake } = await ready(named({ durable: true, messageTtl: 5000 }), { strict: true });
  assert.strictEqual(fake().asserted.queue, 'work');
  assert.strictEqual(fake().asserted.options.expires, undefined);
  assert.strictEqual(fake().asserted.options.durable, true);
  assert.strictEqual(fake().asserted.options.messageTtl, 5000);
});

test('#23 a named queue keeps an expires of its own', async () => {
  const { fake } = await ready(named({ expires: 90000 }), { strict: true });
  assert.strictEqual(fake().asserted.options.expires, 90000);
});

test('#23 a dynamic queue declared again after a re-create keeps expires 1800000', async () => {
  const { channel, connection, fake } = await ready(dynamic(), { strict: true });
  const first = fake();
  channel.consume();
  await settle();
  const name = channel.queue.name;
  first.emit('close');   // the queue is gone with it: the new channel declares it again
  const again = new Promise(resolve => channel.once('recreated', resolve));
  connection.reconnectInterval = 1;
  void channel.alive;
  await again;
  assert.notStrictEqual(fake(), first);
  assert.strictEqual(fake().asserted.queue, name);
  assert.strictEqual(fake().asserted.options.expires, 1800000);
});

// ---- #27 sendToQueue: dead-channel check and options. Without an SDK first: the SDK, once
// started, stays for the rest of the file.

test('#27 sendToQueue with two arguments sends no third argument', async () => {
  const { channel, fake } = await ready(named(), { strict: true });
  channel.sendToQueue('target', { a: 1 });
  assert.deepStrictEqual(fake().sent[0].rest, []);
});

test('#27 sendToQueue passes its options to amqplib as the third argument', async () => {
  const { channel, fake } = await ready(named(), { strict: true });
  const options = { persistent: true, headers: { h: 1 } };
  channel.sendToQueue('target', { a: 1 }, options);
  assert.deepStrictEqual(fake().sent[0].rest, [{ persistent: true, headers: { h: 1 } }]);
});

// a dead channel: the connection is dead too, so reading alive starts no re-create
async function dead() {
  const up = await ready(named(), { strict: true });
  up.fake().emit('close');
  up.connection.alive = false;
  return up;
}

test('#27 a dead channel: sendToQueue throws the Error publish throws', async () => {
  const { channel, fake } = await dead();
  let published;
  assert.throws(() => channel.publish({ a: 1 }, 'rk'), e => (published = e) instanceof Error);
  assert.throws(() => channel.sendToQueue('target', { a: 1 }),
    e => e instanceof Error && e.message === published.message
      && e.message === 'Channel is dead!');
  assert.strictEqual(fake().sent.length, 0);
});

test('#27 a dead channel: sendToQueue emits the small error payload', async () => {
  const { channel, errors } = await dead();
  assert.throws(() => channel.sendToQueue('target', { a: 1 }));
  assert.deepStrictEqual(errors, [{
    message: 'channel is dead!', channelId: channel._id, queue: 'work', exchange: 'events',
  }]);
});

test('#27 a dead channel: sendToQueue is counted channel_dead on amq.default', async t => {
  const { channel } = await dead();
  const { points } = startMetrics(t);
  assert.throws(() => channel.sendToQueue('target', { a: 1 }));
  const sent = await points('messaging.client.sent.messages');
  assert.deepStrictEqual(
    sent.map(p => [
      p.attributes['messaging.destination.name'], p.attributes['error.type'], p.value]),
    [['amq.default', 'channel_dead', 1]]);
});

test('#27 under an SDK options carry a traceparent, the caller object stays', async () => {
  const { spans } = startTracing();
  const { channel, fake } = await ready(named(), { strict: true });
  const options = { persistent: true, headers: { h: 1 } };
  channel.sendToQueue('target', { a: 1 }, options);
  const [span] = await spans();
  const sent = fake().sent[0].rest[0];
  assert.strictEqual(sent.persistent, true);
  assert.strictEqual(sent.headers.h, 1);
  assert.match(sent.headers.traceparent, new RegExp(`^00-${span.spanContext().traceId}-`));
  assert.deepStrictEqual(options, { persistent: true, headers: { h: 1 } });
});

test('#27 under an SDK a call with no options still carries the traceparent', async () => {
  startTracing();
  const { channel, fake } = await ready(named(), { strict: true });
  channel.sendToQueue('target', { a: 1 });
  assert.match(fake().sent[0].rest[0].headers.traceparent, /^00-[0-9a-f]{32}-/);
});

// ---- #30 array binding options are awaited

const headers = [{ a: 1 }, { b: 2 }];

test('#30 the dynamic consume waits for every bind of an array', async () => {
  const { channel, fake } = await ready(
    { ...dynamic(), binding: { enabled: true, pattern: 'rk', options: headers } });
  fake().holdBinds = true;
  channel.consume();
  await settle();
  assert.deepStrictEqual(fake().binds, headers);
  assert.deepStrictEqual(fake().consumed, [], 'consume started before the binds finished');
  fake().pendingBinds.forEach(done => done());
  await settle();
  assert.deepStrictEqual(fake().consumed, [`${channel._id}:${os.hostname}`]);
});

test('#30 one refused bind of an array is an error event and no consume', async () => {
  const { channel, errors, fake } = await ready(
    { ...dynamic(), binding: { enabled: true, pattern: 'rk', options: headers } });
  fake().refuse = header => header.b === 2;
  channel.consume();
  await settle();
  assert.deepStrictEqual(errors.map(e => e.message), ['bind refused']);
  assert.deepStrictEqual(fake().consumed, []);
});

test('#30 a named queue whose array bind is refused does not become ready', async () => {
  const connection = {
    alive: true,
    url: 'amqp://user:secret@rabbit.example:5673',
    config: { channelRetryMaxInterval: 60000 },
    reconnectInterval: 60000,
    amqpConnection: {
      createConfirmChannel: () => {
        const c = new BindingChannel();
        c.refuse = header => header.b === 2;
        return Promise.resolve(c);
      },
    },
  };
  const channel = new Channel(connection, {
    exchange: { name: 'events' }, queue: { name: 'work' }, prefetch: 1,
    binding: { enabled: true, pattern: 'rk', options: headers },
  });
  const errors = [];
  channel.on('error', e => errors.push(e));
  let readyEmitted = false;
  channel.on('ready', () => { readyEmitted = true; });
  channel.create();
  await new Promise(resolve => channel.once('error', resolve));
  assert.strictEqual(readyEmitted, false);
  assert.strictEqual(errors[0].message, 'cant establish a channel');
  await channel.close();
});

// ---- live broker: the dynamic queue carries x-expires 1800000

test('live: a dynamic queue carries x-expires 1800000 on the broker',
  { skip: URL_ ? false : 'FAMQP_TEST_URL not set' }, async t => {
  const amqplib = require('amqplib');
  const AMQPPool = require('..');
  const u = new URL(URL_);
  const exchange = `famqp-chsmall-${process.pid}-${Date.now()}`;
  const admin = await amqplib.connect(URL_);
  const adminCh = await admin.createChannel();
  await adminCh.assertExchange(exchange, 'fanout', { durable: false, autoDelete: true });
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50 },
    channel: { prefetch: 5, exchange: { name: exchange, type: 'fanout' },
      binding: { enabled: true, options: [{ x: 1 }, { y: 2 }] },
      queue: { options: { durable: true, exclusive: false, autoDelete: false,
        messageTtl: 60000 } } },
  }]);
  let dynamicName;
  const consuming = new Promise(resolve => pool.on('ready', ch => {
    dynamicName = `${ch._id}:${os.hostname}`;
    ch.on('info', i => { if (i?.message?.startsWith?.('consume from queue')) resolve(); });
    ch.consume();
  }));
  pool.on('error', () => {});
  t.after(async () => {
    const stopped = pool.stop();
    pool.on('error', () => {});
    await stopped.catch(() => {});
    if (dynamicName) await adminCh.deleteQueue(dynamicName).catch(() => {});
    await adminCh.deleteExchange(exchange).catch(() => {});
    await admin.close().catch(() => {});
  });
  await consuming;
  const base = { durable: true, autoDelete: false, messageTtl: 60000 };
  const declare = options => admin.createChannel().then(c => {
    c.on('error', () => {});   // a refused declare closes the channel
    return c.assertQueue(dynamicName, options);
  });
  await assert.doesNotReject(declare({ ...base, expires: 1800000 }));
  await assert.rejects(declare({ ...base, expires: 1799999 }), /PRECONDITION_FAILED/);
  await assert.rejects(declare(base), /PRECONDITION_FAILED/);
});
