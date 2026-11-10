// Channel#publish and #sendToQueue: the channel's default options stay untouched, and
// sendToQueue sends its buffer and is counted like a publish.
const { test } = require('node:test');
const assert = require('node:assert');
const Channel = require('../Channel');
const api = require('@opentelemetry/api');
const { startTracing, startMetrics } = require('./helpers/otel');
const { FakeAmqpChannel } = require('./helpers/fakes');

async function readyChannel() {
  const amqp = [];
  const connection = {
    alive: true,
    url: 'amqp://user:secret@rabbit.example:5673',
    amqpConnection: {
      createConfirmChannel: () => {
        const c = new FakeAmqpChannel();
        amqp.push(c);
        return Promise.resolve(c);
      },
    },
  };
  const config = { exchange: { name: 'events' }, queue: { name: 'q' }, prefetch: 1 };
  const channel = new Channel(connection, config);
  channel.on('error', () => {});
  const ready = new Promise(resolve => channel.once('ready', resolve));
  channel.create();
  await ready;
  return { channel, fake: () => amqp[amqp.length - 1] };
}

test('two publishes without options: distinct messageIds, channel.options untouched', async () => {
  const { channel, fake } = await readyChannel();
  channel.publish({ a: 1 }, 'rk');
  channel.publish({ a: 2 }, 'rk');
  const [first, second] = fake().published.map(p => p.options.messageId);
  assert.ok(first && second);
  assert.notStrictEqual(first, second);
  assert.strictEqual(channel.options.messageId, undefined);
  assert.strictEqual(channel.options.timestamp, undefined);
});

test('a caller props object still receives its messageId and timestamp', async () => {
  const { channel, fake } = await readyChannel();
  const props = {};
  channel.publish({ a: 1 }, 'rk', props);
  assert.ok(props.messageId);
  assert.strictEqual(typeof props.timestamp, 'number');
  assert.strictEqual(fake().published[0].options.messageId, props.messageId);
});

test('sendToQueue sends the JSON buffer to amqplib with the queue name', async () => {
  const { channel, fake } = await readyChannel();
  const obj = { a: 1 };
  channel.sendToQueue('target', obj);
  assert.strictEqual(fake().sent.length, 1);
  assert.strictEqual(fake().sent[0].queue, 'target');
  assert.deepStrictEqual(fake().sent[0].content, Buffer.from(JSON.stringify(obj)));
  assert.deepStrictEqual(fake().sent[0].rest, []);
});

test('sendToQueue is counted on messaging.client.sent.messages, amq.default', async t => {
  const { channel } = await readyChannel();
  const { points } = startMetrics(t);
  channel.sendToQueue('target', { a: 1 });
  const sent = await points('messaging.client.sent.messages');
  const got = sent.map(p => [p.attributes['messaging.destination.name'], p.value]);
  assert.deepStrictEqual(got, [['amq.default', 1]]);
});

test('a failing sendToQueue is counted with its error.type and rethrown', async t => {
  const { channel, fake } = await readyChannel();
  const { points } = startMetrics(t);
  fake().sendToQueue = () => { throw new RangeError('table too big'); };
  assert.throws(() => channel.sendToQueue('target', { a: 1 }), RangeError);
  const sent = await points('messaging.client.sent.messages');
  const got = sent.map(p => [p.attributes['error.type'], p.value]);
  assert.deepStrictEqual(got, [['RangeError', 1]]);
});

test('sendToQueue is a PRODUCER span on the default exchange with the catalogue attributes', async () => {
  const { spans } = startTracing();
  const { channel } = await readyChannel();
  channel.sendToQueue('target', { a: 1 });
  const [span] = await spans();
  assert.strictEqual(span.name, 'publish amq.default');
  assert.strictEqual(span.kind, api.SpanKind.PRODUCER);
  assert.deepStrictEqual(span.attributes, {
    'messaging.system': 'rabbitmq',
    'messaging.operation.name': 'publish',
    'messaging.operation.type': 'send',
    'messaging.destination.name': 'amq.default',
    'server.address': 'rabbit.example',
    'server.port': 5673,
  });
});
