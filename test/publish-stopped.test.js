// #66: publish() after stop() throws Pool is stopped, as the methods that open something do.
// Nothing sleeps: timers are node:test mock timers.
const { test } = require('node:test');
const assert = require('node:assert');
const { fake, rig } = require('./helpers/stubpool');

const filters = [
  ['no filter', []],
  ['rr', ['rr']],
  ['all', ['all']],
  ['a function filter', [() => null]],
];
for (const [name, args] of filters) {
  test(`publish() after stop() throws Pool is stopped and caches nothing: ${name}`, async t => {
    const { pool } = rig(t);
    await pool.stop();
    assert.throws(() => pool.publish({ a: 1 }, ...args), { message: 'Pool is stopped' });
    assert.strictEqual(pool.msgCache.length, 0);
  });
}

test('publish() with no arguments after stop() throws Pool is stopped, not a TypeError',
  async t => {
    const { pool } = rig(t);
    await pool.stop();
    assert.throws(() => pool.publish(), { message: 'Pool is stopped' });
  });

test('publish() after stop() reaches no alive channel', async t => {
  const A = fake('A');
  const { pool } = rig(t, { alive: [A] });
  await pool.stop();
  assert.throws(() => pool.publish({ a: 1 }, 'all'), { message: 'Pool is stopped' });
  assert.deepStrictEqual(A.got, []);
});

test('publish() before stop() still sends and caches', t => {
  const A = fake('A');
  const { pool, setAlive } = rig(t, { alive: [A] });
  pool.publish({ n: 1 });
  assert.strictEqual(A.got.length, 1);
  setAlive([]);
  pool.publish({ n: 2 });
  assert.strictEqual(pool.msgCache.length, 1);
});

test('the retry tick still publishes a cached message while the pool runs', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const A = fake('A');
  const { pool } = rig(t, { alive: [A] });
  pool.start(10);
  pool.msgCache.push({ msg: { n: 1 }, filter: undefined });
  t.mock.timers.tick(10);
  assert.strictEqual(A.got.length, 1);
  assert.strictEqual(pool.msgCache.length, 0);
});
