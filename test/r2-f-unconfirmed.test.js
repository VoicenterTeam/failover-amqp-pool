// #79: a Channel keeps each message it publishes until the broker confirms it. A nack, or a close
// of the amqplib channel with confirms still pending, hands those messages back in one
// 'unconfirmed' event; each is handed back once, and never while its confirm is still pending.
const { test } = require('node:test');
const assert = require('node:assert');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');

// a fake that keeps amqplib's confirm callbacks, in publish order
class ConfirmingChannel extends FakeAmqpChannel {
  constructor() {
    super();
    this.confirms = [];
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

async function ready() {
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
  const channel = new Channel(connection, { exchange: { name: 'events' }, topic: 'rk' });
  channel.on('error', () => {});
  const handed = [];
  channel.on('unconfirmed', entries => handed.push(entries));
  const up = new Promise(resolve => channel.once('ready', resolve));
  channel.create();
  await up;
  return { channel, connection, handed, fake: () => amqp[amqp.length - 1] };
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
    props: { messageId: 's-1' }, reason: 'nack' }]]);
});

test('sendToQueue: a close hands back a pending message, reason closed', async () => {
  const { channel, handed, fake } = await ready();
  channel.sendToQueue('target', { n: 1 });
  fake().close();
  await tick();
  assert.deepStrictEqual(handed, [[{ method: 'sendToQueue', queue: 'target', msg: '{"n":1}',
    props: undefined, reason: 'closed' }]]);
});

test('on a close, \'unconfirmed\' fires after the channel has marked itself down', async () => {
  const { channel, fake } = await ready();
  channel.publish({ n: 1 });
  const aliveWhenHanded = new Promise(resolve =>
    channel.once('unconfirmed', () => resolve(channel.isAlive)));
  fake().close();
  assert.strictEqual(await aliveWhenHanded, false);
});
