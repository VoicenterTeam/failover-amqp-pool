// #74: a declare the broker refuses by closing the connection (541 on 4.3, for a transient queue
// that is not exclusive) is reported once per refusal: the connection's { error, url }, with no
// 'cant establish a channel' from any create the close failed. Other connection errors (a socket
// error, a heartbeat timeout) are reported as before, and the connection still reconnects.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const Connection = require('../Connection');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');
const { MGMT, mgmt, until } = require('./helpers/mgmt');

const URL_FAKE = 'amqp://u:p@rabbit.example:5672/';
const refusal = () =>
  Object.assign(new Error('Connection closed: 541 (INTERNAL-ERROR)'), { code: 541 });
const turns = async (n) => {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
};
// a pinned count of 1 ms waits, for rows whose retry runs on a timer
async function waitFor(done, what, tries = 200) {
  for (let i = 0; i < tries && !done(); i++) await new Promise(r => setTimeout(r, 1));
  assert.ok(done(), `gave up waiting for ${what}`);
}

// amqplib.connect resolves fakes; decide(conn, channel, queue, n) answers each declare, where n
// is the connection's index
function fakeBroker(t, decide) {
  const real = amqplib.connect;
  const made = [];
  amqplib.connect = () => {
    const conn = new EventEmitter();
    const n = made.length;
    conn.pending = [];
    conn.close = () => { conn.emit('close'); return Promise.resolve(); };
    conn.createConfirmChannel = () => {
      const c = new FakeAmqpChannel();
      c.strictQueues = true;   // the check draws a 404, the create declares next
      c.assertQueue = (q) => decide(conn, c, q, n);
      return Promise.resolve(c);
    };
    made.push(conn);
    return Promise.resolve(conn);
  };
  t.after(() => { amqplib.connect = real; });
  return made;
}
// like amqplib on a server ConnectionClose or a socket error: the connection's 'error', every
// pending call rejecting with a generic Error, then the connection's 'close'
function closeAll(conn, error) {
  conn.emit('error', error);
  for (const reject of conn.pending.splice(0)) reject(new Error('Channel ended'));
  conn.emit('close', error);
}
// a declare left pending until the connection closes; then() runs on the next turn
const pending = (conn, then) => new Promise((_, reject) => {
  conn.pending.push(reject);
  if (then) setImmediate(then);
});
function wire(t, names, reconnectInterval = 60000) {
  const conn = new Connection(URL_FAKE, { reconnectInterval });
  const errors = [];
  conn.on('error', e => errors.push({ from: 'connection', e }));
  for (const name of names) {
    const ch = new Channel(conn, { queue: { name } });
    ch.on('error', e => errors.push({ from: name, e }));
    conn.addChannel(ch);
  }
  t.after(() => conn.disconnect());
  return { conn, errors };
}
const code = x => (x.e?.err ?? x.e?.error)?.code;

test('#74 a declare refused by a connection close emits one error, the refusal with its url',
  async t => {
  fakeBroker(t, conn => pending(conn, () => closeAll(conn, refusal())));
  const { conn, errors } = wire(t, ['work']);
  conn.start();
  await turns(20);
  assert.strictEqual(errors.length, 1, 'one report');
  assert.strictEqual(errors[0].from, 'connection');
  assert.strictEqual(errors[0].e.error.code, 541);
  assert.strictEqual(errors[0].e.url, conn.safeUrl);
});

test('#74 one refusal with two creates in flight is one error, no channel blamed', async t => {
  fakeBroker(t, (conn, c, q) =>
    pending(conn, q === 'refused' ? () => closeAll(conn, refusal()) : null));
  const { conn, errors } = wire(t, ['healthy', 'refused']);
  conn.start();
  await turns(20);
  assert.deepStrictEqual(errors.map(x => [x.from, code(x)]), [['connection', 541]]);
});

test('#74 a socket error during a create still reaches error with its url', async t => {
  fakeBroker(t, conn => pending(conn, () => closeAll(conn,
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))));
  const { conn, errors } = wire(t, ['work']);
  conn.start();
  await turns(20);
  const fromConn = errors.filter(x => x.from === 'connection');
  assert.strictEqual(fromConn.length, 1, 'the socket error reached the connection error');
  assert.strictEqual(fromConn[0].e.url, conn.safeUrl);
  // not the broker's refusal: the create it failed reports as on master
  const own = errors.filter(x => x.from === 'work').map(x => x.e.message);
  assert.deepStrictEqual(own, ['cant establish a channel']);
});

test('#74 a refusal whose channel the app closes in the same turn is still reported once',
  async t => {
  let ch;
  fakeBroker(t, conn => pending(conn, () => {
    conn.emit('error', refusal());
    ch.close();   // the app closes the channel between the error and the create's catch
    for (const r of conn.pending.splice(0)) r(new Error('Channel ended'));
    conn.emit('close');
  }));
  const { conn, errors } = wire(t, ['work']);
  ch = conn.channels[0];
  conn.start();
  await turns(20);
  assert.strictEqual(errors.filter(x => code(x) === 541).length, 1, 'the 541 reported once');
});

test('#74 the create after a refused one reports its own failure again', async t => {
  // connection 0 is refused; on connection 1 the declare is refused at channel level (403)
  fakeBroker(t, (conn, c, q, n) => {
    if (n === 0) return pending(conn, () => closeAll(conn, refusal()));
    const e = Object.assign(new Error('403 (ACCESS-REFUSED)'), { code: 403 });
    c.emit('error', e);
    return Promise.reject(e);
  });
  const { conn, errors } = wire(t, ['work'], 1);
  conn.start();
  await waitFor(() => errors.some(x => x.from === 'work'), 'the second create\'s error');
  const own = errors.find(x => x.from === 'work');
  assert.strictEqual(own.e.message, 'cant establish a channel');
  assert.strictEqual(own.e.err.code, 403);
});

test('#74 an idle channel at the refusal still reports its next failed create', async t => {
  // connection 0: 'idle' is created, then 'refused' is refused by a connection close; on
  // connection 1 the declare of 'idle' is refused at channel level (403)
  fakeBroker(t, (conn, c, q, n) => {
    if (n === 0 && q === 'refused') return pending(conn, () => closeAll(conn, refusal()));
    if (n === 0 || q !== 'idle') { c.queues.add(q); return Promise.resolve({ queue: q }); }
    const e = Object.assign(new Error('403 (ACCESS-REFUSED)'), { code: 403 });
    c.emit('error', e);
    return Promise.reject(e);
  });
  const { conn, errors } = wire(t, ['idle', 'refused'], 1);
  const failed = [];   // the error each failed create of 'idle' names
  conn.channels[0].on('info', i => {
    if (i?.message === 'channel create failed') failed.push(i.error);
  });
  conn.start();
  await waitFor(() => errors.some(x => x.from === 'idle'), 'the idle channel\'s error');
  // its first failed create is its own 403, reported: not silenced as the earlier refusal's
  assert.strictEqual(failed[0], '403 (ACCESS-REFUSED)');
  assert.strictEqual(errors.find(x => x.from === 'idle').e.err.code, 403);
});

test('#74 a connection error with no create in flight still reaches error', async t => {
  const made = fakeBroker(t, (conn, c, q) => {
    c.queues.add(q);
    return Promise.resolve({ queue: q });
  });
  const { conn, errors } = wire(t, ['work']);
  const up = new Promise(r => conn.channels[0].once('ready', r));
  conn.start();
  await up;
  made[0].emit('error', refusal());
  assert.deepStrictEqual(errors.map(x => [x.from, code(x), x.e.url]),
    [['connection', 541, conn.safeUrl]]);
});

// ---- live broker: 4.3 refuses a transient queue that is not exclusive by closing the connection

const URL_ = process.env.FAMQP_TEST_URL;
const skipLive = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;

async function livePool(t, reconnectInterval, healthy) {
  const version = (await mgmt('GET', 'overview')).rabbitmq_version;
  if (Number(version.split('.')[0]) < 4) {
    t.skip(`RabbitMQ ${version} accepts a transient non-exclusive queue`);
    return null;
  }
  const u = new URL(URL_);
  const Pool = require('..');
  const name = `lane-b-refused-${process.pid}-${Date.now()}`;
  const p = new Pool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), ssl: false, reconnectInterval,
      connection_name: name },
    channel: { queue: { name, options: { durable: false } } },
  }]);
  const kept = `${name}-healthy`;
  if (healthy) p.createChannel(0, { queue: { name: kept, options: { durable: true } } });
  const errors = [];
  const atFailure = [];   // errors.length at each failed create's info
  let connects = 0;
  p.on('error', e => errors.push(e));
  p.on('connection', () => connects++);
  p.on('info', i => {
    if (i?.message === 'channel create failed') atFailure.push(errors.length);
  });
  t.after(async () => {
    await p.stop().catch(() => {});
    if (healthy) await mgmt('DELETE', `queues/%2F/${encodeURIComponent(kept)}`);
  });
  return { errors, atFailure, connects: () => connects };
}

test('live: one refused create on 4.3 emits one pool error', { skip: skipLive }, async t => {
  const live = await livePool(t, 60000);
  if (!live) return;
  await until(() => live.atFailure.length === 1, 'the failed create', 100);
  assert.deepStrictEqual(live.atFailure, [1], 'one error for the one refused create');
  assert.strictEqual(live.errors[0].error?.code, 541);
  assert.ok(live.errors[0].url && !live.errors[0].url.includes('@'), 'the url, no userinfo');
});

test('live: the refused create on 4.3 reconnects and reports once per refusal',
  { skip: skipLive }, async t => {
  const live = await livePool(t, 50);
  if (!live) return;
  await until(() => live.atFailure.length >= 3, 'three failed creates', 100);
  assert.ok(live.connects() >= 3, 'the connection reconnected');
  assert.deepStrictEqual(live.atFailure.slice(0, 3), [1, 2, 3]);
});

test('live: two creates in flight on 4.3, one refused, report the 541 once',
  { skip: skipLive }, async t => {
  const live = await livePool(t, 60000, true);
  if (!live) return;
  await until(() => live.atFailure.length >= 1, 'the failed create', 100);
  // the healthy create may fail on the same close or finish first: a pinned count of polls
  await until(() => live.atFailure.length >= 2, 'a second failed create', 30).catch(() => {});
  assert.strictEqual(live.errors.length, 1, 'one error for the one refusal');
  assert.strictEqual(live.errors[0].error?.code, 541);
});
