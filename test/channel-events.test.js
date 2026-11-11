// What the app is told when a channel closes or a create is refused. The fake behaves like
// amqplib: a refused call closes the channel, which emits 'error' then 'close' at once, and the
// pending call rejects with a different Error object than the one the event carried.
const { test } = require('node:test');
const assert = require('node:assert');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');

const broker = (code) => Object.assign(new Error(`${code} refused`), { code });
function refuse(c, method, code, classId) {
  c[method] = () => {
    c.emit('error', Object.assign(broker(code), { classId }));
    c.emit('close');
    return Promise.reject(Object.assign(broker(code), { classId }));
  };
}
// a missing queue: the passive check refuses with 404 (error, close), as amqplib does
class Missing extends FakeAmqpChannel {
  constructor() {
    super();
    this.strictQueues = true;
  }
  checkQueue(queue) {
    if (this.queues.has(queue)) return Promise.resolve({ queue });
    refuse(this, 'checkQueue', 404);
    return this.checkQueue(queue);
  }
}

// a closed amqplib channel rejects every later call
function alive(c) {
  c.assertExchange ??= () => Promise.resolve();
  c.on('close', () => {
    c.dead = true;
  });
  for (const m of [
    'checkQueue',
    'assertQueue',
    'bindQueue',
    'assertExchange',
    'checkExchange',
    'prefetch',
  ]) {
    const call = c[m];
    c[m] = (...a) => (c.dead ? Promise.reject(new Error('Channel closed')) : call.apply(c, a));
  }
  return c;
}

function setup(config, make = () => new Missing()) {
  const made = [];
  const connection = {
    alive: true,
    url: 'amqp://u:p@rabbit.example:5672',
    reconnectInterval: 1,
    config: { channelRetryMaxInterval: 1 },
    amqpConnection: {
      createConfirmChannel: () => {
        const c = alive(make(made.length));
        made.push(c);
        return Promise.resolve(c);
      },
    },
  };
  const channel = new Channel(connection, config);
  const log = [];
  for (const e of ['error', 'close', 'info', 'ready', 'recreated'])
    channel.on(e, (a) => log.push([e, a]));
  const of = (e) => log.filter((l) => l[0] === e).map((l) => l[1]);
  return { channel, made, log, of, last: () => made[made.length - 1] };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const named = () => ({ exchange: { name: 'events' }, queue: { name: 'work' } });

// ---- #38

function nullDelivery(closeBehaviour) {
  const { channel, made, of } = setup({ queue: { name: 'work' } }, () => {
    const c = new FakeAmqpChannel();
    c.close = closeBehaviour;
    return c;
  });
  return { channel, made, of };
}
async function consumeThenCancel(ctx) {
  const up = new Promise((r) => ctx.channel.once('ready', r));
  ctx.channel.create();
  await up;
  ctx.channel.consume();
  await settle();
  ctx.made[0].consumers[0](null); // the broker cancelled the consumer
  await settle();
}
async function noUnhandled(run) {
  const seen = [];
  const f = (e) => seen.push(e);
  process.on('unhandledRejection', f);
  try {
    await run();
    await settle();
  } finally {
    process.off('unhandledRejection', f);
  }
  return seen;
}

test('#38 a null delivery whose close() rejects leaves no unhandled rejection', async () => {
  const ctx = nullDelivery(() => Promise.reject(new Error('Channel closed')));
  const seen = await noUnhandled(() => consumeThenCancel(ctx));
  assert.deepStrictEqual(seen, []);
});

test('#38 a null delivery whose close() throws is caught', async () => {
  const ctx = nullDelivery(() => {
    throw new Error('Channel closed');
  });
  await consumeThenCancel(ctx); // an escaping throw fails here
  assert.strictEqual(ctx.of('error').filter((e) => e.message === 'Message is null').length, 1);
});

test('#38 a null delivery still reports, closes and re-creates the channel', async () => {
  let closes = 0;
  const ctx = nullDelivery(function () {
    closes++;
    return Promise.resolve();
  });
  await consumeThenCancel(ctx);
  const nulls = ctx.of('error').filter((e) => e.message === 'Message is null');
  assert.strictEqual(nulls.length, 1);
  assert.deepStrictEqual(Object.keys(nulls[0]).sort(), [
    'channelId',
    'exchange',
    'message',
    'queue',
  ]);
  assert.strictEqual(closes, 1);
  assert.strictEqual(ctx.made.length, 2, 're-created on a new amqplib channel');
  assert.strictEqual(ctx.made[1].consumers.length, 1, 'and consuming again');
});

// ---- #62

test('#62 the expected 404 of a first declare emits no close', async () => {
  const { channel, of, last } = setup(named());
  channel.create();
  await settle();
  assert.deepStrictEqual(of('close'), []);
  assert.deepStrictEqual(of('error'), []);
  assert.strictEqual(last().asserted.queue, 'work');
  assert.strictEqual(of('ready').length, 1);
});

test('#62 the expected 404 of a dynamic-queue reconnect emits no close', async () => {
  const { channel, of } = setup({
    exchange: { name: 'events' },
    binding: { enabled: true },
    prefetch: 1,
  });
  channel.create();
  await settle();
  channel.consume();
  await settle();
  const first = of('close').length;
  channel.create(); // a new connection: the new fake lacks the exclusive queue
  await settle();
  assert.strictEqual(of('close').length, first);
  assert.strictEqual(of('recreated').length, 1);
  assert.deepStrictEqual(of('error'), []);
});

test('#62 a real close after the expected 404 still emits close', async () => {
  const { channel, of, last } = setup(named());
  channel.create();
  await settle();
  assert.deepStrictEqual(of('close'), []);
  // the declared channel is lost: one container, the exempt 404 and a real close
  last().emit('close');
  assert.strictEqual(of('close').length, 1);
  assert.strictEqual(channel.isAlive, false);
});

test('#62 a close that is not the check 404 emits close, the check in flight', async () => {
  const { channel, of } = setup(named(), (i) => {
    const c = new FakeAmqpChannel();
    // the create's own cleanup close must not emit, or it would satisfy the count by itself
    c.close = () => Promise.resolve();
    if (i === 0) {
      c.checkQueue = () => {
        c.emit('close'); // lost, no 404
        return Promise.reject(new Error('Channel closed'));
      };
    }
    return c;
  });
  const up = new Promise((r) => channel.once('ready', r)); // the retry succeeds
  channel.create();
  await up;
  assert.strictEqual(of('close').length, 1, 'the one close reached the app');
});

test('#62 close() of a live channel emits close', async () => {
  const { channel, of } = setup({ queue: { name: 'work' } }, () => new FakeAmqpChannel());
  const up = new Promise((r) => channel.once('ready', r));
  channel.create();
  await up;
  await channel.close();
  assert.strictEqual(of('close').length, 1);
});

// ---- #63: one failed create, one 'error'

const wrapper = (e) => e?.message === 'cant establish a channel';
const failed = (log) =>
  log.filter((l) => l[0] === 'info' && l[1]?.message === 'channel create failed').length;
const rows = [
  ['403 on the queue check', named(), (c) => refuse(c, 'checkQueue', 403), 403],
  ['403 on the exchange check', named(), (c) => refuse(c, 'checkExchange', 403), 403],
  [
    '406 on the queue declare',
    named(),
    (c) => {
      c.strictQueues = true;
      refuse(c, 'assertQueue', 406);
    },
    406,
  ],
  [
    '403 on the bind',
    { ...named(), binding: { enabled: true } },
    (c) => {
      c.queues.add('work');
      refuse(c, 'bindQueue', 403);
    },
    403,
  ],
  [
    '403 on the exchange declare',
    { exchange: { name: 'events', type: 'fanout' }, queue: { name: 'work' } },
    (c) => refuse(c, 'assertExchange', 403),
    403,
  ],
];
for (const [name, config, tune, code] of rows) {
  test(`#63 ${name}: one failed create emits one error`, async () => {
    const { channel, of, log } = setup(config, () => {
      const c = new Missing();
      tune(c);
      return c;
    });
    channel.create();
    await settle();
    await settle();
    // each attempt is one error followed by its 'channel create failed' info
    const seq = log
      .filter(
        (l) => l[0] === 'error' || (l[0] === 'info' && l[1]?.message === 'channel create failed'),
      )
      .map((l) => l[0]);
    assert.ok(failed(log) >= 1, 'a create failed');
    const pairs = seq.join(',');
    assert.match(pairs, /^(error,info,)*(error,info)$/, pairs);
    assert.ok(of('error').every(wrapper), 'the documented wrapper');
    assert.strictEqual(of('error')[0].err.code, code);
    channel.close();
  });
}

test('#63 a create that fails twice emits one error per attempt', async () => {
  const { channel, of, log } = setup(named(), () => {
    const c = new Missing();
    refuse(c, 'checkQueue', 403);
    return c;
  });
  channel.create();
  // a pinned number of polls, the retry timer is 1 ms
  for (let i = 0; i < 500 && failed(log) < 2; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(failed(log) >= 2);
  assert.strictEqual(of('error').length, failed(log));
  channel.close();
});

test('#63 a channel error during a create that then succeeds is reported once', async () => {
  const { channel, of } = setup({ exchange: { name: 'events', type: 'fanout' } }, (i) => {
    const c = new FakeAmqpChannel();
    // the durable escape: a new channel carries on
    if (i === 0) refuse(c, 'assertExchange', 406, 40);
    return c;
  });
  const up = new Promise((r) => channel.once('ready', r));
  channel.create();
  await up;
  await settle();
  assert.strictEqual(of('error').length, 1);
  assert.strictEqual(of('error')[0].code, 406);
});

test('#63 an error on a created channel is emitted at once, once', async () => {
  const { channel, of, last } = setup({ queue: { name: 'work' } }, () => new FakeAmqpChannel());
  const up = new Promise((r) => channel.once('ready', r));
  channel.create();
  await up;
  last().emit('error', broker(404));
  assert.strictEqual(of('error').length, 1);
  assert.strictEqual(of('error')[0].code, 404);
});

test('#63 a durable escape that then fails on a 403 reports the 406 and the 403', async () => {
  const config = { exchange: { name: 'events', type: 'fanout' }, queue: { name: 'work' } };
  const { channel, of, log } = setup(config, (i) => {
    const c = new FakeAmqpChannel();
    if (i % 2 === 0)
      refuse(c, 'assertExchange', 406, 40); // the escape, then the next channel
    else refuse(c, 'checkQueue', 403); // refuses the queue check
    return c;
  });
  channel.create();
  for (let i = 0; i < 500 && failed(log) < 1; i++) await new Promise((r) => setTimeout(r, 2));
  channel.close();
  const [held, wrapped] = of('error');
  assert.strictEqual(held.code, 406, 'the recovered escape is still reported');
  assert.strictEqual(wrapped.message, 'cant establish a channel');
  assert.strictEqual(wrapped.err.code, 403);
});
