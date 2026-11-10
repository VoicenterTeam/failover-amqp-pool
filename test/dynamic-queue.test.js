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
const dynamic = { exchange: { name: 'events' }, binding: { enabled: true, pattern: 'rk' }, prefetch: 1 };

test('dynamic consume names the queue and consumes once on it', async () => {
  const { channel, fake } = await ready(dynamic);
  const consumed = [];
  fake().consume = (q, cb, o) => { consumed.push(q); return Promise.resolve({ consumerTag: o.consumerTag }); };
  channel.consume();
  await settle();
  const name = `${channel._id}:${os.hostname}`;
  assert.strictEqual(channel.queue.name, name);
  assert.deepStrictEqual(consumed, [name]);
  assert.deepStrictEqual(fake().bound, { queue: name, exchange: 'events', pattern: 'rk' });
});

test('dynamic consume enters consume() twice at most', async () => {
  const { channel, entered } = await ready(dynamic);
  channel.consume();
  await settle();
  assert.ok(entered.n <= 2, `consume() entered ${entered.n} times`);
});

test('no name from the broker: an error event and no consume', async () => {
  const { channel, fake, errors } = await ready(dynamic, c => {
    c.checkQueue = () => Promise.resolve({});
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

test('named queue (green before and after): one consume with its consumerTag', async () => {
  const { channel, fake, entered } = await ready({ exchange: { name: 'events' }, queue: { name: 'q' } });
  const consumed = [];
  fake().consume = (q, cb, o) => { consumed.push({ q, tag: o.consumerTag }); return Promise.resolve({}); };
  channel.consume();
  await settle();
  assert.strictEqual(entered.n, 1);
  assert.strictEqual(consumed.length, 1);
  assert.strictEqual(consumed[0].q, 'q');
  assert.ok(consumed[0].tag);
});
