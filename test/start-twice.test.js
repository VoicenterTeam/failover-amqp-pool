// #69: start() twice left the first timer running, since stop() clears only the last one, so
// the process never ended. The timers are counted, not waited for: a replaced one is cleared.
const { test } = require('node:test');
const assert = require('node:assert');
const { fake, rig } = require('./helpers/stubpool');

// setInterval and clearInterval that keep the set of timers started and not yet cleared
function countTimers(t) {
  const active = new Set();
  t.mock.method(globalThis, 'setInterval', () => {
    const timer = { unref() {} };
    active.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearInterval', timer => { active.delete(timer); });
  return active;
}

test('start() twice, then stop(): no timer is left running', async t => {
  const active = countTimers(t);
  const { pool } = rig(t);
  pool.start(10);
  pool.start(10);
  await pool.stop();
  assert.strictEqual(active.size, 0);
});

test('start() twice while running leaves one timer, the second', t => {
  const active = countTimers(t);
  const { pool } = rig(t);
  pool.start(10);
  const first = pool.interval;
  pool.start(10);
  assert.strictEqual(active.size, 1);
  assert.ok(!active.has(first), 'the first timer was cleared');
  assert.ok(active.has(pool.interval), 'the second runs');
});

test('start() once, then stop(): no timer is left running', async t => {
  const active = countTimers(t);
  const { pool } = rig(t);
  pool.start(10);
  assert.strictEqual(active.size, 1);
  await pool.stop();
  assert.strictEqual(active.size, 0);
});

test('a restarted pool still retries its cache, one pass per tick', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { pool } = rig(t, { all: [fake('A')] });
  let passes = 0;
  pool.start(10);
  pool.start(10);
  pool.msgCache.push({ msg: { n: 1 }, filter: () => { passes++; return null; } });
  t.mock.timers.tick(10);
  assert.strictEqual(passes, 1, 'one timer, one retry pass per tick');
});
