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

