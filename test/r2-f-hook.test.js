// #79, the pool's side: a Channel's 'unconfirmed' entries are cached and re-sent by start()'s
// tick on the channel that lost them (a sendToQueue entry to the same queue), each message at
// most MAX times; stop() waits a bounded time for confirms and reports what is left once.
// amqplib is faked; the tick and the stop wait run on node:test mock timers.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const AMQPPool = require('..');
const { FakeAmqpChannel } = require('./helpers/fakes');

const tick = () => new Promise(resolve => process.nextTick(resolve));
const flush = () => new Promise(setImmediate);

// keeps amqplib's confirm callbacks, and like amqplib fails the pending ones on 'close'
class ConfirmingChannel extends FakeAmqpChannel {
  constructor() {
    super();
    this.confirms = [];
    this.on('close', () => {
      for (const cb of this.confirms) if (cb) cb(new Error('channel closed'));
    });
  }
  publish(exchange, routingKey, content, options, cb) {
    super.publish(exchange, routingKey, content, options);
    this.published[this.published.length - 1].content = content.toString();
    this.confirms.push(cb);
    return true;
  }
  sendToQueue(queue, content, ...rest) {
    super.sendToQueue(queue, content, ...rest);
    this.confirms.push(rest[1]);
    return true;
  }
  settle(err = null) {
    const pending = this.confirms;
    this.confirms = pending.map(() => null);
    for (const cb of pending) if (cb) cb(err);
  }
}

// A pool on a faked amqplib with the channels given, all ready. amqp(i) is channel i's current
// amqplib channel; channel(i) its Channel. The retry tick is a mock setInterval.
async function readyPool(t, names = ['a'], { timers = ['setInterval'] } = {}) {
  t.mock.timers.enable({ apis: timers });
  const made = [];
  t.mock.method(amqplib, 'connect', () => {
    const c = new EventEmitter();
    c.createConfirmChannel = () => {
      const f = new ConfirmingChannel();
      made.push(f);
      return Promise.resolve(f);
    };
    c.close = () => {
      for (const f of made) if (!f.closed) { f.closed = true; f.emit('close'); }
      c.emit('close');
      return Promise.resolve();
    };
    return Promise.resolve(c);
  });
  const pool = new AMQPPool([{ connection: { host: 'rabbit.example', port: 5672 },
    channels: names.map(k => ({ exchange: { name: 'x' }, topic: k })) }]);
  const heard = { error: [], info: [], unconfirmed: [] };
  for (const event of Object.keys(heard)) pool.on(event, e => heard[event].push(e));
  t.after(() => pool.stop({ confirmTimeout: 0 }).catch(() => {}));
  for (let i = 0; i < 50 && pool.getAliveChannels().length < names.length; i++) await flush();
  const channel = i => pool.getAllChannels()[i];
  return { pool, heard, made, channel, amqp: i => channel(i).amqpChannel };
}
const BOTH = { timers: ['setInterval', 'setTimeout'] };
const drops = heard => heard.info.filter(e => e?.message === 'cached message dropped');

test('an \'all\' message nacked on the second channel is re-sent on that channel only',
  async t => {
    const { pool, amqp } = await readyPool(t, ['a', 'b']);
    pool.start(10);
    pool.publish({ n: 1 }, 'all', undefined, { messageId: 'm-1' });
    amqp(1).settle(new Error('message nacked'));
    await tick();
    assert.strictEqual(pool.msgCache.length, 1);
    t.mock.timers.tick(10);
    assert.deepStrictEqual(
      [amqp(0).published.length, amqp(1).published.length, pool.msgCache.length], [1, 2, 0]);
    assert.strictEqual(amqp(1).published[1].options.messageId, 'm-1');
  });

test('a channel the broker closes: its messages go out on its next amqplib channel, in order,'
  + ' in one tick', async t => {
  const { pool, amqp } = await readyPool(t);
  pool.start(10);
  for (let n = 0; n < 50; n++) pool.publish({ n }, undefined, undefined, { messageId: `m-${n}` });
  const lost = amqp(0);
  lost.emit('close');
  await tick();
  assert.strictEqual(pool.msgCache.length, 50);
  t.mock.timers.tick(10);   // reading alive starts the re-create
  for (let i = 0; i < 20; i++) await flush();
  assert.notStrictEqual(amqp(0), lost);
  t.mock.timers.tick(10);
  assert.deepStrictEqual(amqp(0).published.map(p => p.options.messageId),
    Array.from({ length: 50 }, (_, n) => `m-${n}`));
  assert.strictEqual(pool.msgCache.length, 0);
});

test('a sendToQueue message nacked is re-sent to the same queue on the same channel',
  async t => {
    const { pool, channel, amqp } = await readyPool(t, ['a', 'b']);
    pool.start(10);
    channel(0).sendToQueue('target', { n: 1 }, { messageId: 's-1' });
    amqp(0).settle(new Error('message nacked'));
    await tick();
    t.mock.timers.tick(10);
    assert.deepStrictEqual(amqp(0).sent.map(s => [s.queue, s.rest[0]]),
      [['target', { messageId: 's-1' }], ['target', { messageId: 's-1' }]]);
    assert.deepStrictEqual([amqp(1).sent.length, amqp(1).published.length], [0, 0]);
  });

test('a message nacked on every send goes out 1 + 5 times, then is dropped with one info',
  async t => {
    const { pool, heard, amqp } = await readyPool(t);
    pool.start(10);
    pool.publish({ n: 1 }, undefined, undefined, { messageId: 'm-1' });
    for (let i = 0; i < 8; i++) {
      amqp(0).settle(new Error('message nacked'));
      await tick();
      t.mock.timers.tick(10);
    }
    assert.strictEqual(amqp(0).published.length, 6);
    assert.deepStrictEqual(drops(heard), [{ message: 'cached message dropped',
      messageId: 'm-1', channelId: pool.getAllChannels()[0]._id,
      reason: 're-publish limit reached', attempts: 5, lastReason: 'nack', cause: null }]);
    assert.strictEqual(pool.msgCache.length, 0);
  });

test('a hand-back from a channel closed with close() is not cached, with one info', async t => {
  const { pool, heard, channel, amqp } = await readyPool(t);
  pool.publish({ n: 1 }, undefined, undefined, { messageId: 'm-1' });
  amqp(0).emit('close');   // the broker closes it; the hand-back is on the next tick
  channel(0).close();      // and the app closes the Channel in the same turn
  await tick();
  assert.strictEqual(pool.msgCache.length, 0);
  assert.deepStrictEqual(drops(heard).map(d => [d.messageId, d.reason]),
    [['m-1', 'channel is closed']]);
});

test('stop() waits for the confirms in flight, and reports nothing when they come',
  async t => {
    const { pool, heard, amqp } = await readyPool(t, ['a'], BOTH);
    pool.publish({ n: 1 });
    pool.publish({ n: 2 });
    let stopped = false;
    const stopping = pool.stop().then(() => { stopped = true; });
    await flush();
    assert.strictEqual(stopped, false);
    amqp(0).settle(null);
    await stopping;
    assert.deepStrictEqual([heard.unconfirmed, heard.info.filter(i =>
      i?.message === 'unconfirmed messages at stop')], [[], []]);
  });

test('stop() reports what is unconfirmed after confirmTimeout once, then resolves', async t => {
  const { pool, heard, channel } = await readyPool(t, ['a'], BOTH);
  const id = channel(0)._id;
  pool.publish({ n: 1 }, undefined, undefined, { messageId: 'm-1' });
  pool.publish({ n: 2 }, undefined, undefined, { messageId: 'm-2' });
  const stopping = pool.stop({ confirmTimeout: 100 });
  await flush();
  t.mock.timers.tick(100);
  await stopping;
  assert.deepStrictEqual(heard.unconfirmed.map(es => es.map(e => [e.props.messageId, e.reason,
    e.channelId])), [[['m-1', 'timeout', id], ['m-2', 'timeout', id]]]);
  assert.deepStrictEqual(heard.info.filter(i => i?.message === 'unconfirmed messages at stop'),
    [{ message: 'unconfirmed messages at stop', count: 2 }]);
});

test('stop() with no argument waits 5000 ms', async t => {
  const { pool } = await readyPool(t, ['a'], BOTH);
  pool.publish({ n: 1 });
  let stopped = false;
  pool.stop().then(() => { stopped = true; });
  await flush();
  t.mock.timers.tick(4999);
  await flush();
  assert.strictEqual(stopped, false);
  t.mock.timers.tick(1);
  for (let i = 0; i < 5 && !stopped; i++) await flush();
  assert.strictEqual(stopped, true);
});

test('stop() with nothing in flight resolves without waiting', async t => {
  const { pool, heard } = await readyPool(t, ['a'], BOTH);
  await pool.stop();
  assert.deepStrictEqual(heard.unconfirmed, []);
});

test('stop() refuses a confirmTimeout that is not a whole number from 0 to 2147483647, and the'
  + ' pool keeps running', async t => {
  const { pool } = await readyPool(t);
  const rows = { negative: -1, nan: NaN, fraction: 1.5, string: '5', tooBig: 2 ** 31,
    nul: null };
  for (const [row, confirmTimeout] of Object.entries(rows)) {
    await assert.rejects(pool.stop({ confirmTimeout }),
      { name: 'TypeError', message: /^stop: confirmTimeout must be/ }, row);
  }
  assert.doesNotThrow(() => pool.publish({ n: 1 }));
});

test('stop(): a message the broker hands back during the wait is reported, not cached',
  async t => {
    const { pool, heard, amqp } = await readyPool(t, ['a'], BOTH);
    pool.publish({ n: 1 }, undefined, undefined, { messageId: 'm-1' });
    const stopping = pool.stop({ confirmTimeout: 100 });
    await flush();
    amqp(0).emit('close');
    await stopping;
    assert.deepStrictEqual(heard.unconfirmed.flat().map(e => [e.props.messageId, e.reason]),
      [['m-1', 'closed']]);
    assert.strictEqual(pool.msgCache.length, 0);
  });

test('stop(): an unconfirmed listener that throws is a warning; stop() still resolves',
  async t => {
    const { pool, amqp } = await readyPool(t, ['a'], BOTH);
    const warned = t.mock.method(process, 'emitWarning', () => {});
    pool.on('unconfirmed', () => { throw new Error('listener bug'); });
    pool.publish({ n: 1 });
    const stopping = pool.stop({ confirmTimeout: 10 });
    await flush();
    t.mock.timers.tick(10);
    await stopping;
    assert.deepStrictEqual(warned.mock.calls.map(c => c.arguments[0].message), ['listener bug']);
    void amqp;
  });

test('stop() takes the pool\'s unconfirmed listener off each channel', async t => {
  const { pool, channel } = await readyPool(t);
  const first = channel(0);
  const before = first.listenerCount('unconfirmed');
  await pool.stop();
  assert.deepStrictEqual([before, first.listenerCount('unconfirmed')], [1, 0]);
});
