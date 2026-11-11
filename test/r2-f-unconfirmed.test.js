// #79: a Channel keeps each message it publishes until the broker confirms it. A nack, or a close
// of the amqplib channel with confirms still pending, hands those messages back in one
// 'unconfirmed' event; each is handed back once, and never while its confirm is still pending.
const { test } = require('node:test');
const assert = require('node:assert');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');

// a fake that keeps amqplib's confirm callbacks, in publish order. Like amqplib 2.3.1's channel
// constructor, it fails every pending callback on 'close', from a listener added first.
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
    this.published[this.published.length - 1].content = content;
    this.confirms.push(cb);
    return true;
  }
  sendToQueue(queue, content, ...rest) {
    super.sendToQueue(queue, content, ...rest);
    this.confirms.push(rest[1]);
    return true;
  }
}

async function ready(config = { exchange: { name: 'events' }, topic: 'rk' }) {
  const amqp = [];
  const connection = {
    alive: true,
    url: 'amqp://rabbit.example:5672',
    amqpConnection: {
      createConfirmChannel: () => {
        const c = new ConfirmingChannel();
        amqp.push(c);
        return Promise.resolve(c);
      },
    },
  };
  const channel = new Channel(connection, config);
  channel.on('error', () => {});
  const infos = [];
  channel.on('info', i => infos.push(i));
  const handed = [];
  channel.on('unconfirmed', entries => handed.push(entries));
  const up = new Promise(resolve => channel.once('ready', resolve));
  channel.create();
  await up;
  return { channel, connection, handed, infos, fake: () => amqp[amqp.length - 1] };
}
const nacked = () => new Error('message nacked');
// 'unconfirmed' is emitted on the next tick
const tick = () => new Promise(resolve => process.nextTick(resolve));

test('publish hands amqplib a confirm callback as its fifth argument', async () => {
  const { channel, fake } = await ready();
  channel.publish({ n: 1 });
  assert.strictEqual(typeof fake().confirms[0], 'function');
});

test('sendToQueue hands amqplib undefined options and a confirm callback', async () => {
  const { channel, fake } = await ready();
  channel.sendToQueue('target', { n: 1 });
  assert.strictEqual(fake().sent[0].rest.length, 2);
  assert.strictEqual(fake().sent[0].rest[0], undefined);
  assert.strictEqual(typeof fake().sent[0].rest[1], 'function');
});

test('an acked message is not handed back, now or on a later close', async () => {
  const { channel, handed, fake } = await ready();
  channel.publish({ n: 1 });
  fake().confirms[0](null);
  fake().close();
  await tick();
  assert.deepStrictEqual(handed, []);
});

test('a nacked publish is handed back alone, reason nack, with its message and messageId',
  async () => {
    const { channel, handed, fake } = await ready();
    channel.publish({ n: 1 }, 'rk', { messageId: 'm-1' });
    channel.publish({ n: 2 }, 'rk', { messageId: 'm-2' });
    fake().confirms[0](nacked());
    await tick();
    assert.strictEqual(handed.length, 1);
    assert.deepStrictEqual(handed[0].map(e => [e.method, e.msg, e.topic, e.props.messageId,
      e.reason]), [['publish', '{"n":1}', 'rk', 'm-1', 'nack']]);
  });

test('a close hands back every pending message in one event, in publish order, reason closed',
  async () => {
    const { channel, handed, fake } = await ready();
    for (const n of [1, 2, 3]) channel.publish({ n }, 'rk', { messageId: `m-${n}` });
    fake().confirms[1](null);
    fake().close();
    await tick();
    assert.strictEqual(handed.length, 1);
    assert.deepStrictEqual(handed[0].map(e => [e.props.messageId, e.reason]),
      [['m-1', 'closed'], ['m-3', 'closed']]);
  });

test('a message whose confirm is pending is not handed back', async () => {
  const { channel, handed } = await ready();
  channel.publish({ n: 1 });
  channel.sendToQueue('target', { n: 2 });
  await tick();
  assert.deepStrictEqual(handed, []);
});

test('a confirm callback after the close hand-back hands nothing back again', async () => {
  const { channel, handed, fake } = await ready();
  channel.publish({ n: 1 }, 'rk', { messageId: 'm-1' });
  fake().close();
  fake().confirms[0](new Error('channel closed'));
  await tick();
  assert.deepStrictEqual(handed.flat().map(e => e.props.messageId), ['m-1']);
});

test('a nacked message is not handed back again by the close', async () => {
  const { channel, handed, fake } = await ready();
  channel.publish({ n: 1 }, 'rk', { messageId: 'm-1' });
  fake().confirms[0](nacked());
  fake().close();
  await tick();
  assert.deepStrictEqual(handed.flat().map(e => [e.props.messageId, e.reason]),
    [['m-1', 'nack']]);
});

test('a publish amqplib refuses is not tracked: the close hands nothing back', async () => {
  const { channel, handed, fake } = await ready();
  fake().publishError = new RangeError('table too big');
  assert.throws(() => channel.publish({ n: 1 }), RangeError);
  fake().close();
  await tick();
  assert.deepStrictEqual(handed, []);
});

test('publish() with no message, or an empty one, tracks nothing', async () => {
  const { channel, handed, fake } = await ready();
  channel.publish();
  channel.publish('');
  fake().close();
  await tick();
  assert.deepStrictEqual([fake().published.length, handed.length], [0, 0]);
});

test('the close of a replaced amqplib channel hands back only its own messages', async () => {
  const { channel, handed, fake } = await ready();
  const old = fake();
  channel.publish({ n: 1 }, 'rk', { messageId: 'old' });
  channel.alive = false;
  const again = new Promise(resolve => channel.once('recreated', resolve));
  channel.create();
  await again;
  channel.publish({ n: 2 }, 'rk', { messageId: 'new' });
  old.close();
  await tick();
  assert.deepStrictEqual(handed.flat().map(e => e.props.messageId), ['old']);
});

test('an entry published again sends the same content and messageId', async () => {
  const { channel, handed, fake } = await ready();
  channel.publish({ n: 1 }, 'rk', { messageId: 'm-1' });
  fake().confirms[0](nacked());
  await tick();
  const [entry] = handed[0];
  channel.publish(entry.msg, entry.topic, entry.props);
  const [first, second] = fake().published;
  assert.deepStrictEqual(second.content, first.content);
  assert.strictEqual(second.options.messageId, 'm-1');
});

test('sendToQueue: a nack hands back the queue, message and options, reason nack', async () => {
  const { channel, handed, fake } = await ready();
  channel.sendToQueue('target', { n: 1 }, { messageId: 's-1' });
  fake().confirms[0](nacked());
  await tick();
  assert.deepStrictEqual(handed, [[{ method: 'sendToQueue', queue: 'target', msg: '{"n":1}',
    props: { messageId: 's-1' }, reason: 'nack', cause: null }]]);
});

test('sendToQueue: a close hands back a pending message, reason closed', async () => {
  const { channel, handed, fake } = await ready();
  channel.sendToQueue('target', { n: 1 });
  fake().close();
  await tick();
  assert.deepStrictEqual(handed, [[{ method: 'sendToQueue', queue: 'target', msg: '{"n":1}',
    props: undefined, reason: 'closed', cause: null }]]);
});

test('on a close, \'unconfirmed\' fires after the channel has marked itself down', async () => {
  const { channel, fake } = await ready();
  channel.publish({ n: 1 });
  const aliveWhenHanded = new Promise(resolve =>
    channel.once('unconfirmed', () => resolve(channel.isAlive)));
  fake().close();
  assert.strictEqual(await aliveWhenHanded, false);
});

// ---- review of PR #100: the cause, the Channel's own closes, the info

test('a channel the broker closes with an error hands back with that error as the cause',
  async () => {
    const { channel, handed, fake } = await ready();
    channel.publish({ n: 1 }, 'rk', { messageId: 'm-1' });
    fake().emit('error', Object.assign(new Error('NOT_FOUND - no exchange'), { code: 404 }));
    fake().close();
    await tick();
    assert.deepStrictEqual(handed.flat().map(e => [e.reason, e.cause]),
      [['closed', { code: 404, message: 'NOT_FOUND - no exchange' }]]);
  });

test('a close with no channel error, as on a connection drop, hands back with cause null',
  async () => {
    const { channel, handed, fake } = await ready();
    channel.publish({ n: 1 });
    fake().close();
    await tick();
    assert.deepStrictEqual(handed.flat().map(e => [e.reason, e.cause]), [['closed', null]]);
  });

test('a nack hands back with cause null', async () => {
  const { channel, handed, fake } = await ready();
  channel.publish({ n: 1 });
  fake().confirms[0](nacked());
  await tick();
  assert.deepStrictEqual(handed.flat().map(e => [e.reason, e.cause]), [['nack', null]]);
});

test('the Channel\'s own close() hands nothing back', async () => {
  const { channel, handed } = await ready();
  channel.publish({ n: 1 });
  channel.sendToQueue('target', { n: 2 });
  await channel.close();
  await tick();
  assert.deepStrictEqual(handed, []);
});

test('close() hands nothing back for its channel; a replaced one closed by the broker does',
  async () => {
    const { channel, handed, fake } = await ready();
    const old = fake();
    channel.publish({ n: 1 }, 'rk', { messageId: 'old' });
    channel.alive = false;
    const again = new Promise(resolve => channel.once('recreated', resolve));
    channel.create();
    await again;
    channel.publish({ n: 2 }, 'rk', { messageId: 'current' });
    await channel.close();
    old.close();
    await tick();
    assert.deepStrictEqual(handed.flat().map(e => e.props.messageId), ['old']);
  });

test('a re-create after the broker cancels the consumer hands nothing back', async () => {
  const { channel, handed, fake } = await ready({ exchange: { name: 'events' },
    queue: { name: 'work' }, topic: 'rk' });
  channel.consume();
  await tick();
  const cancelled = fake();
  channel.publish({ n: 1 });
  cancelled.consumers.forEach(cb => cb(null));
  await tick();
  assert.deepStrictEqual(handed, []);
});

test('a hand-back emits one info with its count, reason, cause and channelId', async () => {
  const { channel, infos, fake } = await ready();
  channel.publish({ n: 1 });
  channel.publish({ n: 2 });
  fake().close();
  await tick();
  assert.deepStrictEqual(infos.filter(i => i?.message === 'unconfirmed messages handed back'),
    [{ message: 'unconfirmed messages handed back', count: 2, reason: 'closed', cause: null,
      channelId: channel._id }]);
});

// ---- waitConfirmed(ms): what stop() waits on. It resolves with the messages still unconfirmed
// when every held message is confirmed or ms has passed; those leftovers are released.

test('waitConfirmed() with nothing held resolves [] at once', async () => {
  const { channel } = await ready();
  assert.deepStrictEqual(await channel.waitConfirmed(50), []);
});

test('waitConfirmed() resolves [] once every held message is confirmed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel, fake } = await ready();
  channel.publish({ n: 1 });
  channel.sendToQueue('target', { n: 2 });
  const waited = channel.waitConfirmed(1000);
  fake().confirms[0](null);
  fake().confirms[1](null);
  assert.deepStrictEqual(await waited, []);
});

test('waitConfirmed() after ms resolves the unconfirmed ones, reason timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel, fake } = await ready();
  for (const n of [1, 2]) channel.publish({ n }, 'rk', { messageId: `m-${n}` });
  const waited = channel.waitConfirmed(1000);
  fake().confirms[0](null);
  t.mock.timers.tick(1000);
  assert.deepStrictEqual((await waited).map(e => [e.props.messageId, e.reason, e.cause]),
    [['m-2', 'timeout', null]]);
});

test('waitConfirmed() leftovers are released: a later close or confirm hands nothing back',
  async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { channel, handed, fake } = await ready();
    channel.publish({ n: 1 });
    channel.publish({ n: 2 });
    const waited = channel.waitConfirmed(10);
    t.mock.timers.tick(10);
    await waited;
    fake().confirms[0](nacked());
    fake().close();
    await tick();
    assert.deepStrictEqual(handed, []);
  });

test('waitConfirmed() with no argument waits 5000 ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel } = await ready();
  channel.publish({ n: 1 });
  let left = null;
  channel.waitConfirmed().then(l => { left = l; });
  t.mock.timers.tick(4999);
  await tick();
  assert.strictEqual(left, null);
  t.mock.timers.tick(1);
  await tick();
  assert.strictEqual(left.length, 1);
});

test('waitConfirmed() during a broker close: the close hands them back, the wait gets []',
  async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { channel, handed, fake } = await ready();
    channel.publish({ n: 1 });
    const waited = channel.waitConfirmed(1000);
    fake().close();
    assert.deepStrictEqual(await waited, []);
    await tick();
    assert.strictEqual(handed.flat().length, 1);
  });

test('waitConfirmed() refuses an ms that is not a whole number from 0 to 2147483647',
  async () => {
    const { channel } = await ready();
    const rows = { negative: -1, nan: NaN, infinite: Infinity, fraction: 1.5, string: '5',
      tooBig: 2 ** 31, nul: null };
    for (const [row, ms] of Object.entries(rows)) {
      assert.throws(() => channel.waitConfirmed(ms),
        { name: 'TypeError', message: /^waitConfirmed: ms must be/ }, row);
    }
  });
