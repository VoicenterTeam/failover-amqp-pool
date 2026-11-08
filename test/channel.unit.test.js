// Unit tests for channel re-create and stale acks, with a fake amqplib channel.
const { test } = require('node:test');
const assert = require('node:assert');
const { once, EventEmitter } = require('node:events');
const Channel = require('../Channel');

class FakeAmqpChannel extends EventEmitter {
  constructor() {
    super();
    this.acks = [];
    this.nacks = [];
    this.consumers = [];
    this.tag = 0;
  }
  prefetch() { return Promise.resolve(); }
  checkQueue(queue) { return Promise.resolve({ queue }); }
  consume(queue, cb, opts) { this.consumers.push({ cb, opts }); return Promise.resolve({ consumerTag: opts.consumerTag }); }
  ack(msg) { this.acks.push(msg.fields.deliveryTag); }
  nack(msg) { this.nacks.push(msg.fields.deliveryTag); }
  close() { this.emit('close'); }
  deliver(body) {
    const m = { content: Buffer.from(body), fields: { deliveryTag: ++this.tag }, properties: {} };
    this.consumers.forEach(c => c.cb(m));
    return m;
  }
}

function setup() {
  const amqpChannels = [];
  const connection = {
    alive: true,
    url: 'amqp://fake',
    metrics: null,
    amqpConnection: {
      createConfirmChannel: () => {
        const c = new FakeAmqpChannel();
        amqpChannels.push(c);
        return Promise.resolve(c);
      }
    }
  };
  const channel = new Channel(connection, { queue: { name: 'q' }, prefetch: 1 });
  const infos = [];
  const errors = [];
  channel.on('info', i => infos.push(i));
  channel.on('error', e => errors.push(e));
  return { channel, amqpChannels, infos, errors };
}

const created = ch => new Promise(resolve => {
  const f = i => { if (i?.message === 'channel created') { ch.off('info', f); setImmediate(resolve); } };
  ch.on('info', f);
});

async function recreate(channel, amqpChannels) {
  const done = created(channel);
  amqpChannels.at(-1).close();   // broker side close: the wrapper marks itself dead
  channel.alive;                 // the next use re-creates it, as in the pool
  await done;
}

test('consumer written as on(ready, ch => ch.on(message)) sees each delivery once after re-creates', async () => {
  const { channel, amqpChannels } = setup();
  let handled = 0;
  channel.on('ready', ch => { ch.on('message', () => handled++); ch.consume(); });
  const first = created(channel);
  channel.create();
  await first;
  for (let k = 0; k < 3; k++) await recreate(channel, amqpChannels);
  const current = amqpChannels.at(-1);
  assert.strictEqual(current.consumers.length, 1, 'exactly one consumer on the new channel');
  current.deliver('x');
  assert.strictEqual(handled, 1);
});

test('stale ack and nack are dropped, not sent on the new channel', async () => {
  const { channel, amqpChannels, infos, errors } = setup();
  channel.on('ready', ch => ch.consume());
  const first = created(channel);
  channel.create();
  await first;
  let stale;
  channel.once('message', m => { stale = m; });
  amqpChannels[0].deliver('old');
  await recreate(channel, amqpChannels);
  const current = amqpChannels.at(-1);
  assert.notStrictEqual(current, amqpChannels[0]);

  channel.ack(stale);
  channel.nack(stale);
  assert.deepStrictEqual(current.acks, []);
  assert.deepStrictEqual(current.nacks, []);
  const dropped = infos.filter(i => /stale/.test(i?.message));
  assert.strictEqual(dropped.length, 2);
  for (const i of dropped) {
    assert.deepStrictEqual(Object.keys(i).sort(), ['channelId', 'message', 'messageId', 'reason']);
    assert.strictEqual(i.messageId, stale.properties.messageId);
  }
  assert.deepStrictEqual(errors, []);

  // control: a message delivered on the current channel acks and nacks normally
  let fresh;
  channel.once('message', m => { fresh = m; });
  current.deliver('new');
  channel.ack(fresh);
  channel.nack(fresh);
  assert.deepStrictEqual(current.acks, [fresh.fields.deliveryTag]);
  assert.deepStrictEqual(current.nacks, [fresh.fields.deliveryTag]);
});

test("'ready' fires on the first create only, 'recreated' after each re-create", async () => {
  const { channel, amqpChannels } = setup();
  let ready = 0, recreated = 0;
  channel.on('ready', () => ready++);
  channel.on('recreated', () => recreated++);
  const first = created(channel);
  channel.create();
  await first;
  await recreate(channel, amqpChannels);
  await recreate(channel, amqpChannels);
  assert.strictEqual(ready, 1);
  assert.strictEqual(recreated, 2);
});

test("'channel is dead!' error carries a small object, not the Channel", () => {
  const { channel, errors } = setup();
  channel.connection.alive = false;  // create() cannot run, the channel stays dead
  channel.on('error', () => {});
  channel.ack({ fields: { deliveryTag: 1 }, properties: { messageId: 'm' } });
  const dead = errors.find(e => e?.message === 'channel is dead!');
  assert.ok(dead);
  assert.ok(!Object.values(dead).some(v => v instanceof Channel), 'no Channel object in the event');
  assert.ok(JSON.stringify(dead).length < 500);
});
