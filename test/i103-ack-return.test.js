'use strict';
// #103: Channel.ack() and Channel.nack() return true when they hand the message to amqplib and
// false when they drop it. The fake amqplib channel records what reached it.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
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
  consume(queue, cb, opts) {
    this.consumers.push(cb);
    return Promise.resolve({ consumerTag: opts.consumerTag });
  }
  ack(msg) { this.acks.push(msg.fields.deliveryTag); }
  nack(msg) { this.nacks.push(msg.fields.deliveryTag); }
  close() { this.closed = true; this.emit('close'); }
  deliver(body) {
    const m = { content: Buffer.from(body), fields: { deliveryTag: ++this.tag }, properties: {} };
    this.consumers.forEach(cb => cb(m));
    return m;
  }
}

const created = ch => new Promise(resolve => {
  const f = i => {
    if (i?.message === 'channel created') { ch.off('info', f); setImmediate(resolve); }
  };
  ch.on('info', f);
});

async function setup() {
  const amqpChannels = [];
  const connection = {
    alive: true,
    url: 'amqp://fake',
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
  channel.on('ready', ch => ch.consume());
  const first = created(channel);
  channel.create();
  await first;
  const next = () => new Promise(resolve => channel.once('message', resolve));
  return { channel, amqpChannels, infos, errors, connection, next };
}

async function recreate(channel, amqpChannels) {
  const done = created(channel);
  amqpChannels.at(-1).close();
  channel.alive;               // the next use re-creates it, as in the pool
  await done;
}

for (const op of ['ack', 'nack']) {
  test(`#103 ${op}() of a message from the current channel returns true and is sent`,
    async () => {
      const { channel, amqpChannels, errors, next } = await setup();
      const got = next();
      amqpChannels[0].deliver('x');
      const msg = await got;
      assert.strictEqual(channel[op](msg), true);
      assert.deepStrictEqual(amqpChannels[0][`${op}s`], [msg.fields.deliveryTag]);
      assert.deepStrictEqual(errors, []);
    });

  test(`#103 ${op}() of a stale message returns false, sends nothing, emits stale ${op} dropped`,
    async () => {
      const { channel, amqpChannels, infos, errors, next } = await setup();
      const got = next();
      amqpChannels[0].deliver('old');
      const stale = await got;
      await recreate(channel, amqpChannels);
      const current = amqpChannels.at(-1);
      assert.notStrictEqual(current, amqpChannels[0]);

      assert.strictEqual(channel[op](stale), false);
      assert.deepStrictEqual(current.acks, []);
      assert.deepStrictEqual(current.nacks, []);
      assert.deepStrictEqual(amqpChannels[0][`${op}s`], []);
      const dropped = infos.filter(i => i?.message === `stale ${op} dropped`);
      assert.strictEqual(dropped.length, 1);
      assert.strictEqual(dropped[0].messageId, stale.properties.messageId);
      assert.deepStrictEqual(errors, []);
    });

  test(`#103 ${op}() on a dead channel returns false and sends nothing`, async () => {
    const { channel, amqpChannels, connection, next } = await setup();
    const got = next();
    amqpChannels[0].deliver('x');
    const msg = await got;
    connection.alive = false;    // connection down: the closed channel waits for a reconnect
    amqpChannels[0].close();
    assert.strictEqual(channel.alive, false);
    assert.strictEqual(channel[op](msg), false);
    assert.deepStrictEqual(amqpChannels[0][`${op}s`], []);
  });

  test(`#103 ${op}() of a message without a delivery tag returns false`, async () => {
    const { channel, amqpChannels } = await setup();
    const msg = { content: Buffer.from('x'), fields: {}, properties: {} };
    assert.strictEqual(channel[op](msg), false);
    assert.deepStrictEqual(amqpChannels[0][`${op}s`], []);
  });

  test(`#103 ${op}() with no message returns false`, async () => {
    const { channel } = await setup();
    assert.strictEqual(channel[op](undefined), false);
  });
}
