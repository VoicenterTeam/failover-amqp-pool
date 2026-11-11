// Live rows for the channel's close and create-failure events, run on whichever broker
// FAMQP_TEST_URL and FAMQP_TEST_MGMT_URL name. Every wait is a pinned number of polls.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const {
  MGMT,
  mgmt,
  until,
  queuePath,
  connectionNamed,
  closeConnection,
} = require('./helpers/mgmt');

const URL_ = process.env.FAMQP_TEST_URL;
const skipLive = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;
let seq = 0;
const unique = (what) => `famqp-cp4-${what}-${process.pid}-${Date.now()}-${seq++}`;

async function api(method, path, body) {
  const m = new URL(MGMT);
  const login = `${decodeURIComponent(m.username)}:${decodeURIComponent(m.password)}`;
  const res = await fetch(`${m.origin}/api/${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(login).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: body && JSON.stringify(body),
  });
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${path}: ${res.status}`);
}

// A pool on the broker whose events are recorded. `user` is a login with no permissions.
async function livePool(t, channelConf, user) {
  const amqplib = require('amqplib');
  const AMQPPool = require('..');
  const u = new URL(URL_);
  const exchange = unique('x');
  const connection_name = unique('conn');
  const admin = await amqplib.connect(URL_);
  const adminCh = await admin.createChannel();
  await adminCh.assertExchange(exchange, 'fanout', { durable: false });
  const queues = [];
  const pool = new AMQPPool([
    {
      connection: {
        host: u.hostname,
        port: Number(u.port),
        username: user?.name ?? decodeURIComponent(u.username),
        password: user?.password ?? decodeURIComponent(u.password),
        ssl: false,
        reconnectInterval: 50,
        connection_name,
      },
      channel: { exchange: { name: exchange, type: 'fanout' }, ...channelConf },
    },
  ]);
  const events = []; // [event, argument] in arrival order
  for (const e of ['error', 'close', 'info', 'ready', 'recreated'])
    pool.on(e, (a) => events.push([e, a]));
  const of = (e) => events.filter((x) => x[0] === e).map((x) => x[1]);
  t.after(async () => {
    const stopped = pool.stop();
    await stopped.catch(() => {});
    for (const q of queues) await adminCh.deleteQueue(q).catch(() => {});
    await adminCh.deleteExchange(exchange).catch(() => {});
    await admin.close().catch(() => {});
  });
  return {
    pool,
    adminCh,
    exchange,
    events,
    of,
    queues,
    connectionName: `${connection_name}_${os.hostname}`,
  };
}
const count = (of, e, pick = () => true) => of(e).filter(pick).length;
const seen = (of, e, pick) => () => count(of, e, pick) > 0;
const bare = (a) => a === undefined; // a channel's close carries no argument

async function noUnhandled(t) {
  const rejected = [];
  const f = (e) => rejected.push(e);
  process.on('unhandledRejection', f);
  t.after(() => process.off('unhandledRejection', f));
  return rejected;
}

test(
  'live: a broker-side consumer cancel leaves no unhandled rejection',
  { skip: skipLive },
  async (t) => {
    const rejected = await noUnhandled(t);
    const name = unique('cancel');
    const { pool, adminCh, of, queues } = await livePool(t, { prefetch: 5, queue: { name } });
    queues.push(name);
    await until(seen(of, 'ready'), 'ready', 90);
    const ch = of('ready')[0];
    ch.consume();
    await until(
      () => of('info').some((i) => i?.message?.startsWith?.('consume started')),
      'consuming',
      90,
    );
    await until(
      async () => (await mgmt('GET', queuePath(name)))?.consumers === 1,
      'one consumer',
      90,
    );
    await adminCh.deleteQueue(name); // the broker cancels the consumer under the channel
    await until(
      seen(of, 'error', (e) => e?.message === 'Message is null'),
      'the null delivery',
      90,
    );
    await until(seen(of, 'recreated'), 're-created', 90);
    assert.deepStrictEqual(rejected, []);
  },
);

test(
  'live: a first declare of a missing queue emits no close and no error',
  { skip: skipLive },
  async (t) => {
    const name = unique('first');
    const { pool, of, queues } = await livePool(t, { prefetch: 5, queue: { name } });
    queues.push(name);
    await until(seen(of, 'ready'), 'ready', 90);
    await until(() => mgmt('GET', queuePath(name)), `queue ${name}`, 90);
    assert.deepStrictEqual(of('close'), []);
    assert.deepStrictEqual(of('error'), []);
  },
);

test(
  'live: a reconnect of a dynamic queue emits one close, the lost connection, and no error',
  { skip: skipLive },
  async (t) => {
    const { pool, of, queues, connectionName } = await livePool(t, {
      prefetch: 1,
      binding: { enabled: true },
    });
    await until(seen(of, 'ready'), 'ready', 90);
    const ch = of('ready')[0];
    ch.consume();
    await until(
      () => of('info').some((i) => i?.message?.startsWith?.('consume from queue')),
      'consuming',
      90,
    );
    queues.push(ch.queue.name);
    await closeConnection(await connectionNamed(connectionName));
    await until(seen(of, 'recreated'), 're-created', 90);
    assert.strictEqual(count(of, 'close', bare), 1, 'the real close of the lost connection only');
    assert.deepStrictEqual(of('error'), []);
  },
);

test('live: a real channel close still emits close', { skip: skipLive }, async (t) => {
  const { pool, of } = await livePool(t, { prefetch: 5 });
  await until(seen(of, 'ready'), 'ready', 90);
  const ch = of('ready')[0];
  const closed = new Promise((r) => ch.once('close', r));
  await ch.amqpChannel.close();
  await closed;
  assert.strictEqual(count(of, 'close', bare), 1);
});

// ---- a refused create

async function throwaway(t, permissions) {
  const name = unique('user');
  const password = 'pw-' + name;
  await api('PUT', `users/${encodeURIComponent(name)}`, { password, tags: '' });
  t.after(() => api('DELETE', `users/${encodeURIComponent(name)}`).catch(() => {}));
  await api('PUT', `permissions/%2F/${encodeURIComponent(name)}`, permissions);
  return { name, password };
}
const none = { configure: '^$', write: '^$', read: '^$' };
const failure = (e) => e?.message === 'channel create failed';

// two failed attempts, each one error followed by its 'channel create failed' info
async function twoFailedCreates(of, events) {
  await until(() => count(of, 'info', failure) >= 2, 'two failed creates', 90);
  const order = events
    .filter((x) => x[0] === 'error' || (x[0] === 'info' && failure(x[1])))
    .map((x) => x[0])
    .join(',');
  assert.match(order, /^(error,info,)+(error,info)?$/, order);
  assert.ok(of('error').every((e) => e?.message === 'cant establish a channel'));
}

test(
  'live: a 403 on the exchange emits one error per failed create',
  { skip: skipLive },
  async (t) => {
    const user = await throwaway(t, none);
    const { of, events } = await livePool(t, {}, user);
    await twoFailedCreates(of, events);
    assert.strictEqual(of('error')[0].err.code, 403);
  },
);

test(
  'live: a 403 on the queue declare emits one error per failed create',
  { skip: skipLive },
  async (t) => {
    const user = await throwaway(t, none);
    const { of, events } = await livePool(
      t,
      { exchange: undefined, queue: { name: unique('denied') } },
      user,
    );
    await twoFailedCreates(of, events);
    assert.strictEqual(of('error')[0].err.code, 403);
  },
);

test(
  'live: a 406 on the queue declare emits one error per failed create',
  { skip: skipLive },
  async (t) => {
    // a quorum queue cannot be exclusive: the broker refuses the declare with 406
    const name = unique('quorum');
    const { of, events, queues } = await livePool(t, {
      queue: {
        name,
        options: { exclusive: true, durable: true, arguments: { 'x-queue-type': 'quorum' } },
      },
    });
    queues.push(name);
    await twoFailedCreates(of, events);
    assert.strictEqual(of('error')[0].err.code, 406);
  },
);
