// #48: 'connection' fires once per successful connect, reconnects included, on the Connection and
// on the pool, carrying the URL without username or password.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const Connection = require('../Connection');
const { FakeAmqpChannel } = require('./helpers/fakes');
const { MGMT, until, connectionNamed, closeConnection } = require('./helpers/mgmt');

const SECRET_URL = 'amqp://lane-user:lane-secret@rabbit.example:5672/';
const SAFE_URL = 'amqp://rabbit.example:5672/';

// amqplib.connect resolves fake connections; made lists them
function fakeBroker(t) {
  const real = amqplib.connect;
  const made = [];
  amqplib.connect = () => {
    const c = new EventEmitter();
    c.createConfirmChannel = () => Promise.resolve(new FakeAmqpChannel());
    c.close = () => { c.emit('close'); return Promise.resolve(); };
    made.push(c);
    return Promise.resolve(c);
  };
  t.after(() => { amqplib.connect = real; });
  return made;
}
// a pinned number of event-loop turns, each long enough for a 1 ms retry timer
async function turnsUntil(done, what, turns = 200) {
  for (let i = 0; i < turns && !done(); i++) await new Promise(r => setTimeout(r, 1));
  assert.ok(done(), `gave up waiting for ${what}`);
}

test('#48 a Connection emits one connection event per connect, reconnect included', async t => {
  const made = fakeBroker(t);
  const conn = new Connection(SECRET_URL, { reconnectInterval: 1 });
  const got = [];
  conn.on('connection', arg => got.push(arg));
  conn.on('error', () => {});
  t.after(() => conn.disconnect());
  conn.start();
  await turnsUntil(() => got.length >= 1, 'the first connection event');
  assert.deepStrictEqual(got, [SAFE_URL]);
  made[0].emit('close');   // the broker closed it; the retry reconnects
  await turnsUntil(() => made.length === 2 && conn.alive, 'the reconnect');
  assert.deepStrictEqual(got, [SAFE_URL, SAFE_URL]);
});

test('#48 the pool forwards connection with the URL and no username or password', async t => {
  fakeBroker(t);
  const Pool = require('..');
  const pool = new Pool([{
    connection: { host: 'rabbit.example', port: 5672, username: 'lane-user',
      password: 'lane-secret', ssl: false },
    channel: { exchange: { name: 'events' } },
  }]);
  const got = [];
  pool.on('connection', arg => got.push(arg));
  pool.on('error', () => {});
  t.after(() => pool.stop().catch(() => {}));
  await turnsUntil(() => got.length >= 1, 'the pool connection event');
  assert.strictEqual(got.length, 1);
  assert.ok(!/lane-user|lane-secret/.test(String(got[0])), `no secret in ${got[0]}`);
  assert.strictEqual(got[0], pool.connections[0].safeUrl);
});

// ---- live broker

const URL_ = process.env.FAMQP_TEST_URL;
const skipLive = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;

test('live: one connection event per connect, one more after a broker-side close',
  { skip: skipLive }, async t => {
  const u = new URL(URL_);
  const name = `lane-b-conn-${process.pid}-${Date.now()}`;
  const Pool = require('..');
  const pool = new Pool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50,
      connection_name: name },
    channel: { exchange: { name: 'amq.fanout' } },
  }]);
  const got = [];
  pool.on('connection', arg => got.push(arg));
  pool.on('error', () => {});
  let ready = 0;
  pool.on('ready', () => ready++);
  let recreated = 0;
  pool.on('recreated', () => recreated++);
  t.after(() => pool.stop().catch(() => {}));
  await until(() => ready === 1, 'ready', 100);
  assert.strictEqual(got.length, 1, 'one event for the first connect');
  assert.ok(!got[0].includes(decodeURIComponent(u.password)), 'no password in the payload');
  assert.ok(!got[0].includes('@'), 'no userinfo in the payload');
  await closeConnection(await connectionNamed(`${name}_${os.hostname}`));
  await until(() => recreated === 1, 'recreated after the broker-side close', 100);
  assert.strictEqual(got.length, 2, 'one more event for the reconnect');
});
