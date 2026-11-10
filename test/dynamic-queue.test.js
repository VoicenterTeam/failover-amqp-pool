// A channel with an exchange and no queue name consumes from a queue it names itself.
// Re-entry is bounded in the tests so a regression fails instead of spinning.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');

const LIMIT = 5;

async function ready(config, tune = () => {}) {
  const amqp = [];
  const connection = {
    alive: true,
    url: 'amqp://user:secret@rabbit.example:5673',
    amqpConnection: {
      createConfirmChannel: () => {
        const c = new FakeAmqpChannel();
        c.strictQueues = true;
        c.queues.add('q');
        tune(c);
        amqp.push(c);
        return Promise.resolve(c);
      },
    },
  };
  const channel = new Channel(connection, config);
  const errors = [];
  channel.on('error', e => errors.push(e));
  const entered = { n: 0 };
  const real = channel.consume.bind(channel);
  channel.consume = (...a) => { if (++entered.n > LIMIT) return; return real(...a); };
  const up = new Promise(resolve => channel.once('ready', resolve));
  channel.create();
  await up;
  return { channel, fake: () => amqp[amqp.length - 1], errors, entered };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
// a fresh config per test: the channel writes the queue name it makes onto config.queue
const dynamic = () => ({
  exchange: { name: 'events' }, binding: { enabled: true, pattern: 'rk' }, prefetch: 1,
  queue: { options: { durable: true, messageTtl: 60000, arguments: { 'x-max-length': 10 } } },
});

test('dynamic consume names the queue and consumes once on it', async () => {
  const { channel, fake } = await ready(dynamic());
  const consumed = [];
  fake().consume = (q, cb, o) => {
    consumed.push(q);
    return Promise.resolve({ consumerTag: o.consumerTag });
  };
  channel.consume();
  await settle();
  const name = `${channel._id}:${os.hostname}`;
  assert.strictEqual(channel.queue.name, name);
  assert.deepStrictEqual(consumed, [name]);
  assert.deepStrictEqual(fake().bound, { queue: name, exchange: 'events', pattern: 'rk' });
});

test('dynamic queue is declared with the options the channel builds', async () => {
  const { channel, fake } = await ready(dynamic());
  channel.consume();
  await settle();
  const { queue, options } = fake().asserted;
  assert.strictEqual(queue, `${channel._id}:${os.hostname}`);
  assert.deepStrictEqual(options, channel.queueOptions);
  assert.strictEqual(options.durable, true);
  assert.strictEqual(options.messageTtl, 60000);
  assert.deepStrictEqual(options.arguments, { 'x-max-length': 10 });
});

test('a refused bind is an error event and no consume', async () => {
  const { channel, fake, errors } = await ready(dynamic(), c => {
    c.bindQueue = () => Promise.reject(new Error('bind refused'));
  });
  let consumed = 0;
  fake().consume = () => { consumed++; return Promise.resolve({}); };
  channel.consume();
  await settle();
  assert.strictEqual(consumed, 0);
  assert.deepStrictEqual(errors.map(e => e.message), ['bind refused']);
});

test('dynamic consume enters consume() twice at most', async () => {
  const { channel, entered } = await ready(dynamic());
  channel.consume();
  await settle();
  assert.ok(entered.n <= 2, `consume() entered ${entered.n} times`);
});

test('no name from the broker: an error event and no consume', async () => {
  const { channel, fake, errors } = await ready(dynamic(), c => {
    c.assertQueue = () => Promise.resolve({});
  });
  let consumed = 0;
  fake().consume = () => { consumed++; return Promise.resolve({}); };
  channel.consume();
  await settle();
  assert.strictEqual(consumed, 0);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].channelId, channel._id);
  assert.strictEqual(typeof errors[0].message, 'string');
});

test('a named queue consumes once with its consumerTag', async () => {
  const { channel, fake, entered } = await ready({
    exchange: { name: 'events' }, queue: { name: 'q' },
  });
  const consumed = [];
  fake().consume = (q, cb, o) => {
    consumed.push({ q, tag: o.consumerTag });
    return Promise.resolve({});
  };
  channel.consume();
  await settle();
  assert.strictEqual(entered.n, 1);
  assert.strictEqual(consumed.length, 1);
  assert.strictEqual(consumed[0].q, 'q');
  assert.ok(consumed[0].tag);
});

// Live broker: a channel with an exchange and binding but no queue name gets a message.
const URL_ = process.env.FAMQP_TEST_URL;
test('live: a queue that does not exist yet is declared, bound and consumed',
  { skip: URL_ ? false : 'FAMQP_TEST_URL not set' }, async t => {
  const amqplib = require('amqplib');
  const AMQPPool = require('..');
  const u = new URL(URL_);
  const exchange = `famqp-dynq-${process.pid}-${Date.now()}`;
  const admin = await amqplib.connect(URL_);
  const adminCh = await admin.createChannel();
  await adminCh.assertExchange(exchange, 'fanout', { durable: false, autoDelete: true });
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50 },
    channel: { prefetch: 5, exchange: { name: exchange, type: 'fanout' },
      binding: { enabled: true },
      queue: { options: { durable: false, autoDelete: false, messageTtl: 60000 } } },
  }]);
  let dynamicName;
  let channel;
  // no pre-created queue: the name is new, so the first consume meets a queue that is missing
  const got = new Promise(resolve => pool.on('ready', ch => {
    channel = ch;
    dynamicName = `${ch._id}:${os.hostname}`;
    ch.on('message', m => { ch.ack(m); resolve(m.content.toString()); });
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
  const deadline = Date.now() + 5000;
  let body;
  // the bind finishes after 'ready'; publish until the consumer has the queue
  while (!body && Date.now() < deadline) {
    adminCh.publish(exchange, '', Buffer.from('hello'));
    body = await Promise.race([got, new Promise(r => setTimeout(() => r(null), 100))]);
  }
  assert.strictEqual(body, 'hello');
  // the broker holds the options the channel sent: the same declare passes, a changed ttl fails
  const same = { ...channel.queueOptions };
  const declare = options => admin.createChannel().then(c => {
    c.on('error', () => {});  // a refused declare closes the channel
    return c.assertQueue(dynamicName, options);
  });
  await assert.doesNotReject(declare(same));
  await assert.rejects(declare({ ...same, messageTtl: 1 }), /PRECONDITION_FAILED/);
});
