// #74: a create the broker refuses by closing the connection (541 on 4.3, for a transient queue
// that is not exclusive) emits one pool 'error', the create's own, carrying the broker's refusal.
// The connection still reconnects, and each failed create still reports once (#63).
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const { FakeAmqpChannel } = require('./helpers/fakes');
const { MGMT, mgmt, until } = require('./helpers/mgmt');

// like amqplib on a server ConnectionClose: the connection's 'error', then every channel closes
// (its pending call rejecting with a generic Error), then the connection's 'close'
function refusedByConnection() {
  return Object.assign(new Error('Connection closed: 541 (INTERNAL-ERROR)'), { code: 541 });
}
function fakeBroker(t, assertQueue) {
  const real = amqplib.connect;
  const made = [];
  amqplib.connect = () => {
    const conn = new EventEmitter();
    conn.close = () => { conn.emit('close'); return Promise.resolve(); };
    conn.createConfirmChannel = () => {
      const c = new FakeAmqpChannel();
      c.strictQueues = true;   // the check draws a 404, the create declares next
      c.assertQueue = (...a) => assertQueue(conn, c, ...a);
      return Promise.resolve(c);
    };
    made.push(conn);
    return Promise.resolve(conn);
  };
  t.after(() => { amqplib.connect = real; });
  return made;
}
function pool(t, queueOptions, reconnectInterval) {
  const Pool = require('..');
  const p = new Pool([{
    connection: { host: 'rabbit.example', port: 5672, username: 'u', password: 'p', ssl: false,
      reconnectInterval },
    channel: { queue: { name: 'work', options: queueOptions } },
  }]);
  const errors = [];
  const atFailure = [];   // errors.length at each failed create's info
  p.on('error', e => errors.push(e));
  p.on('info', i => {
    if (i?.message === 'channel create failed') atFailure.push(errors.length);
  });
  t.after(() => p.stop().catch(() => {}));
  return { pool: p, errors, atFailure };
}
const turns = async (n) => {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
};

test('#74 a declare refused by a connection close emits one error, carrying the refusal',
  async t => {
  fakeBroker(t, (conn, c) => new Promise((_, reject) => {
    conn.emit('error', refusedByConnection());
    reject(new Error('Channel ended, no reply will be forthcoming'));
    c.emit('close');
    conn.emit('close', refusedByConnection());
  }));
  const { errors, atFailure } = pool(t, { durable: false }, 60000);
  await turns(20);
  assert.deepStrictEqual(atFailure, [1], 'one error by the time the create has failed');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].err?.code, 541);
});

test('#74 a connection error with no create in flight still reaches error', async t => {
  const made = fakeBroker(t, (conn, c, queue) => {
    c.queues.add(queue);
    return Promise.resolve({ queue });
  });
  const { pool: p, errors } = pool(t, {}, 60000);
  await new Promise(r => p.once('ready', r));
  made[0].emit('error', refusedByConnection());
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].error?.code, 541);
  assert.strictEqual(errors[0].url, p.connections[0].safeUrl);
});

// ---- live broker: 4.3 refuses a transient queue that is not exclusive by closing the connection

const URL_ = process.env.FAMQP_TEST_URL;
const skipLive = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;

async function livePool(t, reconnectInterval) {
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
  const errors = [];
  const atFailure = [];
  let connects = 0;
  p.on('error', e => errors.push(e));
  p.on('connection', () => connects++);
  p.on('info', i => {
    if (i?.message === 'channel create failed') atFailure.push(errors.length);
  });
  t.after(() => p.stop().catch(() => {}));
  return { errors, atFailure, connects: () => connects };
}

test('live: one refused create on 4.3 emits one pool error', { skip: skipLive }, async t => {
  const live = await livePool(t, 60000);
  if (!live) return;
  await until(() => live.atFailure.length === 1, 'the failed create', 100);
  assert.deepStrictEqual(live.atFailure, [1], 'one error for the one refused create');
  assert.strictEqual(live.errors[0].err?.code, 541);
});

test('live: the refused create on 4.3 reconnects and reports once per create',
  { skip: skipLive }, async t => {
  const live = await livePool(t, 50);
  if (!live) return;
  await until(() => live.atFailure.length >= 3, 'three failed creates', 100);
  assert.ok(live.connects() >= 3, 'the connection reconnected');
  assert.deepStrictEqual(live.atFailure.slice(0, 3), [1, 2, 3]);
});
