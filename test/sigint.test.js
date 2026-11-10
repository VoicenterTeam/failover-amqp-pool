// stop() removes the pool's own SIGINT listener, and only that one. No broker: the pools point
// at a closed local port and are stopped at once.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const AMQPPool = require('..');

const count = () => process.listenerCount('SIGINT');
const build = (name) => {
  const pool = new AMQPPool([{
    connection: { host: '127.0.0.1', port: 1, reconnectInterval: 60000 },
    channel: { queue: { name } }
  }]);
  pool.on('error', () => {});
  return pool;
};

test('stop() puts the SIGINT listener count back to what it was before the pool', async () => {
  const before = count();
  const pool = build('sigint-one');
  assert.strictEqual(count(), before + 1);
  await pool.stop();
  assert.strictEqual(count(), before);
});

test('stopping one pool leaves the other pool listener in place', async () => {
  const before = count();
  const a = build('sigint-a');
  const b = build('sigint-b');
  const both = process.listeners('SIGINT');
  await a.stop();
  assert.strictEqual(count(), before + 1);
  assert.ok(both.includes(process.listeners('SIGINT').at(-1)));
  await b.stop();
  assert.strictEqual(count(), before);
});

test('11 pools built and stopped print no MaxListenersExceededWarning', async () => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  for (let i = 0; i < 11; i++) await build(`sigint-many-${i}`).stop();
  await new Promise(setImmediate);
  process.off('warning', onWarning);
  assert.deepStrictEqual(warnings, []);
});

test('stop() twice removes one listener only', async () => {
  const before = count();
  const a = build('sigint-twice-a');
  const b = build('sigint-twice-b');
  await a.stop();
  await a.stop();
  assert.strictEqual(count(), before + 1);
  await b.stop();
  assert.strictEqual(count(), before);
});

test('stop() still resolves with one index per connection', async () => {
  const pool = build('sigint-promise');
  assert.deepStrictEqual(await pool.stop(), [0]);
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
