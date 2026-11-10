// stop() removes the pool's own SIGINT listener, and only that one. No broker: the pools point
// at a closed local port and are stopped at once.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const AMQPPool = require('..');
const Connection = require('../Connection');
const { FakeAmqpChannel } = require('./helpers/fakes');

const count = () => process.listenerCount('SIGINT');
// Every pool is stopped after its test, so a red run leaves no reconnect timer behind.
const build = (t, name, connection = { host: '127.0.0.1', port: 1 }) => {
  const pool = new AMQPPool([{
    connection: { ...connection, reconnectInterval: 60000 },
    channel: { queue: { name } }
  }]);
  pool.on('error', () => {});
  t.after(() => pool.stop().catch(() => {}));
  return pool;
};

// amqplib.connect opens a fake that closes the way the real one does: 'close' after close().
function mockBroker(t) {
  t.mock.method(amqplib, 'connect', () => {
    const c = new EventEmitter();
    c.close = () => Promise.resolve().then(() => c.emit('close'));
    c.createConfirmChannel = () => Promise.resolve(new FakeAmqpChannel());
    return Promise.resolve(c);
  });
}
const connected = async (pool) => {
  for (let i = 0; i < 1000 && !pool.connections[0].alive; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(pool.connections[0].alive, 'the pool never connected');
};

test('stop() puts the SIGINT listener count back to what it was before the pool', async (t) => {
  const before = count();
  const pool = build(t, 'sigint-one');
  assert.strictEqual(count(), before + 1);
  await pool.stop();
  assert.strictEqual(count(), before);
});

test('stopping one pool leaves the other pool listener in place', async (t) => {
  const before = count();
  const a = build(t, 'sigint-a');
  const b = build(t, 'sigint-b');
  const both = process.listeners('SIGINT');
  await a.stop();
  assert.strictEqual(count(), before + 1);
  assert.strictEqual(process.listeners('SIGINT').at(-1), both.at(-1));
  await b.stop();
  assert.strictEqual(count(), before);
});

test('11 pools built and stopped print no MaxListenersExceededWarning', async (t) => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  for (let i = 0; i < 11; i++) await build(t, `sigint-many-${i}`).stop();
  await new Promise(setImmediate);
  process.off('warning', onWarning);
  assert.deepStrictEqual(warnings, []);
});

test('stop() twice removes one listener only', async (t) => {
  const before = count();
  const a = build(t, 'sigint-twice-a');
  const b = build(t, 'sigint-twice-b');
  await a.stop();
  await a.stop();
  assert.strictEqual(count(), before + 1);
  await b.stop();
  assert.strictEqual(count(), before);
});

test('stop() still resolves with one index per connection', async (t) => {
  const pool = build(t, 'sigint-promise');
  assert.deepStrictEqual(await pool.stop(), [0]);
});

test('stop() of a connected pool removes its SIGINT listener', async (t) => {
  mockBroker(t);
  const before = count();
  const pool = build(t, 'sigint-alive');
  await connected(pool);
  assert.strictEqual(count(), before + 1);
  await pool.stop();
  assert.strictEqual(count(), before);
});

test('stop() that rejects on a throwing disconnect still removes the listener', async (t) => {
  mockBroker(t);
  const before = count();
  const pool = build(t, 'sigint-throws');
  await connected(pool);
  t.mock.method(Connection.prototype, 'disconnect', () => { throw new Error('boom'); });
  await assert.rejects(pool.stop(), /boom/);
  assert.strictEqual(count(), before);
});

const LIVE = process.env.FAMQP_TEST_URL;
test('stop() of a pool on the live broker removes its SIGINT listener',
  { skip: LIVE ? false : 'FAMQP_TEST_URL not set' }, async (t) => {
    const u = new URL(LIVE);
    const before = count();
    const pool = build(t, `sigint-live-${process.pid}-${Date.now()}`, {
      host: u.hostname, port: Number(u.port), ssl: false,
      username: decodeURIComponent(u.username), password: decodeURIComponent(u.password)
    });
    await connected(pool);
    await pool.stop();
    assert.strictEqual(count(), before);
  });

// The handler calls stop(this.callback), but stop() is async and ignores a callback, so the
// handler's process.exit never runs today (recorded as a separate defect). This row pins what
// SIGINT does now: it stops the pool. The child exits 7 once the pool has no connections.
test('SIGINT on a live pool still stops it', async () => {
  const root = path.resolve(__dirname, '..');
  const script = `
    const Pool = require(${JSON.stringify(root)});
    const pool = new Pool([{ connection: { host: '127.0.0.1', port: 1, reconnectInterval: 60000 },
      channel: { queue: { name: 'sigint-child' } } }]);
    pool.on('error', () => {});
    if (process.listenerCount('SIGINT') !== 1) process.exit(3);
    process.kill(process.pid, 'SIGINT');
    const poll = setInterval(() => {
      if (pool.connections.length === 0) process.exit(7);
    }, 10);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'timeout' }); }, 8000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepStrictEqual(result, { code: 7, signal: null });
});
