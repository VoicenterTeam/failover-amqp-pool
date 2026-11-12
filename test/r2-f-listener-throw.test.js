// #79 hook round: a listener that throws on the 'message published' info, which Channel.publish()
// emits after amqplib took the message, must not make publish() throw. A throw there read as a
// failed publish, so the pool cached a message amqplib already had and sent it twice.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');

const tick = () => new Promise(resolve => process.nextTick(resolve));

async function ready() {
  const amqp = [];
  const connection = {
    alive: true,
    url: 'amqp://rabbit.example:5672',
    amqpConnection: {
      createConfirmChannel: () => {
        const c = new FakeAmqpChannel();
        amqp.push(c);
        return Promise.resolve(c);
      },
    },
  };
  const channel = new Channel(connection, { exchange: { name: 'events' }, topic: 'rk' });
  const up = new Promise(resolve => channel.once('ready', resolve));
  channel.on('error', () => {});
  channel.create();
  await up;
  channel.removeAllListeners('error');
  return { channel, fake: () => amqp[amqp.length - 1] };
}
const throwOnPublished = channel => channel.on('info', i => {
  if (i?.message === 'message published') throw new Error('listener bug');
});

test('an info listener that throws after the send: publish() returns, error event once',
  async () => {
    const { channel, fake } = await ready();
    const errors = [];
    channel.on('error', e => errors.push(e));
    throwOnPublished(channel);
    channel.publish({ n: 1 }, 'rk', { messageId: 'm-1' });
    assert.deepStrictEqual([fake().published.length, errors.map(e => e.message)],
      [1, ['listener bug']]);
  });

test('an info listener that throws after the send, no error listener: a warning', async t => {
  const { channel, fake } = await ready();
  const warned = t.mock.method(process, 'emitWarning', () => {});
  throwOnPublished(channel);
  channel.publish({ n: 1 });
  assert.deepStrictEqual([fake().published.length, warned.mock.calls.length,
    warned.mock.calls[0].arguments[0].message], [1, 1, 'listener bug']);
});

test('an info listener that throws a string, no error listener: the string is the warning',
  async t => {
    const { channel, fake } = await ready();
    const warned = t.mock.method(process, 'emitWarning', () => {});
    channel.on('info', i => {
      if (i?.message === 'message published') throw 'listener string';   // not an Error
    });
    channel.publish({ n: 1 });
    assert.deepStrictEqual([fake().published.length, warned.mock.calls.map(c => c.arguments[0])],
      [1, ['listener string']]);
  });

test('an error listener that throws on the reported throw: a warning, publish() returns',
  async t => {
    const { channel, fake } = await ready();
    const warned = t.mock.method(process, 'emitWarning', () => {});
    channel.on('error', () => { throw new Error('error listener bug'); });
    throwOnPublished(channel);
    channel.publish({ n: 1 });
    assert.deepStrictEqual([fake().published.length, warned.mock.calls.length,
      warned.mock.calls[0].arguments[0].message], [1, 1, 'error listener bug']);
  });

test('a written message the info listener threw on is held once: one close hand-back',
  async () => {
    const { channel, fake } = await ready();
    channel.on('error', () => {});
    const handed = [];
    channel.on('unconfirmed', entries => handed.push(...entries));
    throwOnPublished(channel);
    channel.publish({ n: 1 }, 'rk', { messageId: 'm-1' });
    fake().close();
    await tick();
    assert.deepStrictEqual(handed.map(e => e.props.messageId), ['m-1']);
  });

test('pool: a pool info listener that throws after the send caches nothing, sends once',
  async t => {
    const made = [];
    t.mock.method(amqplib, 'connect', () => {
      const c = new EventEmitter();
      c.createConfirmChannel = () => {
        const f = new FakeAmqpChannel();
        made.push(f);
        return Promise.resolve(f);
      };
      c.close = () => { c.emit('close'); return Promise.resolve(); };
      return Promise.resolve(c);
    });
    const AMQPPool = require('..');
    const pool = new AMQPPool([{ connection: { host: 'rabbit.example', port: 5672 },
      channel: { exchange: { name: 'x' } } }]);
    pool.on('error', () => {});
    t.after(() => pool.stop({ confirmTimeout: 0 }));
    for (let i = 0; i < 50 && pool.getAliveChannels().length < 1; i++) await tick();
    pool.on('info', i => { if (i?.message === 'message published') throw new Error('bug'); });
    for (const n of [1, 2, 3]) pool.publish({ n });
    assert.deepStrictEqual([pool.msgCache.length, made[0].published.length], [0, 3]);
  });
