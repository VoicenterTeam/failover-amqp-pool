// Unit tests for channel re-create and stale acks, with a fake amqplib channel.
const { test } = require('node:test');
const assert = require('node:assert');
const { once, EventEmitter } = require('node:events');
const Channel = require('../Channel');
const AMQPPool = require('..');

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
    this.consumers.push({ cb, opts });
    // amqplib rejects consume() on a closed channel (IllegalOperationError)
    return this.failConsume ? Promise.reject(new Error('Channel closed')) : Promise.resolve({ consumerTag: opts.consumerTag });
  }
  ack(msg) { this.acks.push(msg.fields.deliveryTag); }
  nack(msg) { this.nacks.push(msg.fields.deliveryTag); }
  close() { this.closed = true; this.emit('close'); }
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
        if (connection.failNext) {          // created, then set-up fails and the channel is closed
          connection.failNext = false;
          c.prefetch = () => Promise.reject(new Error('Channel closed'));
          c.failConsume = true;
        }
        if (connection.failConsumeNext) { connection.failConsumeNext = false; c.failConsume = true; }
        return Promise.resolve(c);
      }
    }
  };
  const channel = new Channel(connection, { queue: { name: 'q' }, prefetch: 1 });
  const infos = [];
  const errors = [];
  channel.on('info', i => infos.push(i));
  channel.on('error', e => errors.push(e));
  return { channel, amqpChannels, infos, errors, connection };
}

function trackUnhandled() {
  let count = 0;
  const f = () => count++;
  process.on('unhandledRejection', f);
  return async () => {
    await new Promise(r => setImmediate(r));  // rejections surface after the microtask queue drains
    process.off('unhandledRejection', f);
    return count;
  };
}

// settles when a create finishes, whether it succeeded or failed
const created = ch => new Promise(resolve => {
  const f = i => { if (i?.message === 'channel created' || i?.message === 'channel create failed') { ch.off('info', f); setImmediate(resolve); } };
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
  amqpChannels.forEach((c, i) => assert.strictEqual(c.consumers.length, 1, `exactly one consumer on amqp channel ${i}`));
  const current = amqpChannels.at(-1);
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

test('a failed re-create emits no recreated and does not consume on the dead channel', async () => {
  const { channel, amqpChannels, connection, errors } = setup();
  let recreated = 0;
  channel.on('recreated', () => recreated++);
  const first = created(channel);
  channel.create();
  await first;
  channel.consume();
  const unhandled = trackUnhandled();
  connection.failNext = true;
  await recreate(channel, amqpChannels);
  assert.strictEqual(await unhandled(), 0, 'no unhandled rejection');
  assert.strictEqual(recreated, 0);
  assert.strictEqual(amqpChannels.at(-1).consumers.length, 0, 'no consume() on the failed channel');
  assert.ok(errors.some(e => e?.message === 'cant establish a channel'));
});

test('a rejected consume() is reported as an error event, not an unhandled rejection', async () => {
  const { channel, connection, errors } = setup();
  connection.failConsumeNext = true;
  const first = created(channel);
  channel.create();
  await first;
  const unhandled = trackUnhandled();
  channel.consume();
  assert.strictEqual(await unhandled(), 0, 'no unhandled rejection');
  const e = errors.find(e => e?.message === 'consume failed');
  assert.ok(e, 'consume failed error emitted');
  assert.ok(!Object.values(e).some(v => v instanceof Channel), 'no Channel object in the event');
});

test('pool ack/nack of a message whose channel was re-created emits the stale info event', () => {
  const pool = new AMQPPool([]);
  const infos = [];
  pool.on('info', i => infos.push(i));
  const msg = { fields: { deliveryTag: 3 }, properties: { messageId: 'm1', channelId: 'host.gone' } };
  pool.ack(msg);
  pool.nack(msg);
  assert.deepStrictEqual(infos.map(i => i.message), ['stale ack dropped', 'stale nack dropped']);
  for (const i of infos) {
    assert.deepStrictEqual(Object.keys(i).sort(), ['channelId', 'message', 'messageId', 'reason']);
    assert.strictEqual(i.messageId, 'm1');
    assert.strictEqual(i.channelId, 'host.gone');
  }
});

// issue #5 item 1: a failed create leaves the channel dead and retries once per reconnectInterval
test('a failed create leaves alive false and retries after reconnectInterval, one timer at a time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel, amqpChannels, connection, errors } = setup();
  connection.reconnectInterval = 100;
  connection.failNext = true;
  const failed = new Promise(r => channel.on('error', e => { if (e?.message === 'cant establish a channel') setImmediate(r); }));
  channel.create();
  await failed;
  for (let i = 0; i < 3; i++) assert.strictEqual(channel.alive, false, 'dead after a failed create');
  assert.strictEqual(amqpChannels.length, 1, 'reading alive while a retry is pending does not create');
  assert.strictEqual(errors.filter(e => e?.message === 'cant establish a channel').length, 1);
  const ready = once(channel, 'ready');
  t.mock.timers.tick(100);
  await ready;
  assert.strictEqual(channel.alive, true);
  assert.strictEqual(amqpChannels.length, 2, 'exactly one retry');
});

test('close() cancels a pending create retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel, amqpChannels, connection } = setup();
  connection.reconnectInterval = 100;
  connection.failNext = true;
  const failed = new Promise(r => channel.on('error', e => { if (e?.message === 'cant establish a channel') setImmediate(r); }));
  channel.create();
  await failed;
  channel.close();
  t.mock.timers.tick(1000);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(amqpChannels.length, 1, 'no create after close()');
});

// issue #5 item 2: small error payloads, never the Channel or the URL
const smallPayload = (e, keys) => {
  assert.ok(e);
  assert.deepStrictEqual(Object.keys(e).sort(), keys);
  assert.ok(!Object.values(e).some(v => v instanceof Channel), 'no Channel object in the event');
  assert.ok(!JSON.stringify(e).includes('amqp://'), 'no connection URL');
};

test("'Message is null' and 'DELIVERY TAG NOT FOUND' errors carry a small object", async () => {
  const { channel, amqpChannels, errors } = setup();
  channel.on('ready', ch => ch.consume());
  const first = created(channel);
  channel.create();
  await first;
  const again = created(channel);
  amqpChannels[0].consumers[0].cb(null);   // the broker cancelled the consumer; the channel re-creates
  await again;
  smallPayload(errors.find(e => e?.message === 'Message is null'), ['channelId', 'exchange', 'message', 'queue']);
  channel.ack({ fields: {}, properties: { messageId: 'm1' } });
  const notFound = errors.find(e => /DELIVERY TAG NOT FOUND/.test(e?.message));
  smallPayload(notFound, ['channelId', 'exchange', 'message', 'messageId', 'queue']);
  assert.strictEqual(notFound.messageId, 'm1');
  assert.strictEqual(notFound.queue, 'q');
});

// issue #5 item 3: on checkQueue 404 the create waits for assertQueue and fails with it
test('checkQueue 404 then assertQueue failure fails the create, no unhandled rejection', async () => {
  const { channel, amqpChannels, connection, errors } = setup();
  connection.reconnectInterval = 60000;
  let readyCount = 0;
  channel.on('ready', () => readyCount++);
  const origCreate = connection.amqpConnection.createConfirmChannel;
  connection.amqpConnection.createConfirmChannel = () => origCreate().then(c => {
    c.checkQueue = () => Promise.reject(Object.assign(new Error('NOT_FOUND'), { code: 404 }));
    c.assertQueue = () => Promise.reject(Object.assign(new Error('PRECONDITION_FAILED'), { code: 406 }));
    return c;
  });
  const unhandled = trackUnhandled();
  const failed = new Promise(r => channel.on('error', e => { if (e?.message === 'cant establish a channel') r(e); }));
  channel.create();
  const e = await failed;
  assert.strictEqual(e.err.code, 406, 'the create fails with the assertQueue error');
  assert.strictEqual(await unhandled(), 0, 'no unhandled rejection');
  assert.strictEqual(readyCount, 0);
  assert.strictEqual(channel.alive, false);
  assert.strictEqual(amqpChannels.length, 2, 'checkQueue channel plus the assertQueue channel');
  channel.close();
});

// review round 1
test('a create on a dead connection emits no URL or password', async () => {
  const { channel, connection, errors, infos } = setup();
  connection.url = 'amqp://user:s3cret@broker:5672';
  connection.alive = false;
  const failed = created(channel);
  channel.create();
  await failed;
  const events = [...errors, ...infos].filter(e => e?.message === 'cant establish a channel' || e?.message === 'channel create failed');
  assert.strictEqual(events.length, 2);
  for (const e of events) {
    const text = JSON.stringify(e) + String(e.err?.message) + String(e.err?.stack);
    assert.ok(!text.includes('amqp://') && !text.includes('s3cret'), 'no URL or password: ' + text);
  }
});

test('reading alive while the connection is down starts no create', () => {
  const { channel, amqpChannels, connection, errors } = setup();
  connection.alive = false;
  let creates = 0;
  channel.create = () => creates++;
  for (let i = 0; i < 3; i++) channel.ack({ fields: { deliveryTag: 1 }, properties: { messageId: 'm' } });
  assert.strictEqual(creates, 0, 'Connection.connection() re-creates channels on reconnect');
  assert.strictEqual(errors.filter(e => e?.message === 'channel is dead!').length, 3);
  assert.strictEqual(amqpChannels.length, 0);
});

test('create retries back off exponentially up to channelRetryMaxInterval and reset after success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel, amqpChannels, connection } = setup();
  connection.reconnectInterval = 100;
  connection.config = { channelRetryMaxInterval: 500 };
  const settle = () => created(channel);
  // the create fails while failNext is set; returns the delay until the next attempt
  const nextAttempt = async () => {
    const before = amqpChannels.length;
    let waited = 0;
    while (amqpChannels.length === before) {
      assert.ok(waited <= 1000, 'a retry is scheduled');
      t.mock.timers.tick(50); waited += 50;
      await new Promise(r => setImmediate(r));
    }
    return waited;
  };
  connection.failNext = true;
  let done = settle(); channel.create(); await done;
  const delays = [];
  for (let i = 0; i < 4; i++) {
    connection.failNext = true;
    done = settle(); delays.push(await nextAttempt()); await done;
  }
  assert.deepStrictEqual(delays, [100, 200, 400, 500], 'doubles from reconnectInterval, capped');
  assert.ok(amqpChannels.slice(0, -1).every(c => c.closed), 'each failed amqplib channel is closed');
  done = settle(); delays.push(await nextAttempt()); await done;   // the capped retry succeeds
  assert.strictEqual(channel.alive, true);
  connection.failNext = true;   // a later failure starts again from reconnectInterval
  done = settle(); amqpChannels.at(-1).close(); channel.alive; await done;
  done = settle(); assert.strictEqual(await nextAttempt(), 100); await done;
  channel.close();
});
