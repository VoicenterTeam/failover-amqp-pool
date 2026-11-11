// #70: the retry tick keeps cached messages in publish order. An entry that cannot go out stays
// where it is, and does not hold back an entry a live channel takes. Stub channels, mock ticks.
const { test } = require('node:test');
const assert = require('node:assert');
const { stub, rig } = require('./r2-e-rig');

test('no channel up: cached messages keep publish order on every tick', t => {
  const A = stub('A', { up: false });
  const { pool, cached, tick } = rig(t, [A]);
  for (const n of [1, 2, 3]) pool.publish({ n });
  const seen = [];
  for (let i = 0; i < 3; i++) { tick(); seen.push(cached()); }
  assert.deepStrictEqual(seen, [[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
});

test('an entry for a down channel does not hold back one a live channel takes, same tick', t => {
  const [A, B] = [stub('A', { up: false }), stub('B', { up: false })];
  const { pool, cached, tick } = rig(t, [A, B]);
  pool.publish({ n: 'X' }, () => [B]);
  pool.publish({ n: 'Y' });
  A.up = true;
  tick();
  assert.deepStrictEqual({ A: A.got, cache: cached() }, { A: ['Y'], cache: ['X'] });
});

test('entries for one channel go out in publish order around an entry for another', t => {
  const [A, B] = [stub('A', { up: false }), stub('B', { up: false })];
  const { pool, tick } = rig(t, [A, B]);
  const toB = () => [B];
  pool.publish({ n: 'X' }, toB);
  pool.publish({ n: 'Y' });
  pool.publish({ n: 'Z' }, toB);
  A.up = true;
  tick();
  B.up = true;
  tick(3);
  assert.deepStrictEqual({ A: A.got, B: B.got }, { A: ['Y'], B: ['X', 'Z'] });
});

test('a channel that fails in a tick is not tried again in it: its entries keep order', t => {
  const A = stub('A', { up: false });
  const { pool, tick } = rig(t, [A]);
  pool.publish({ n: 1 });
  pool.publish({ n: 2 });
  Object.assign(A, { up: true, failures: 1 });
  tick(3);
  assert.deepStrictEqual(A.got, [1, 2]);
});

test('a listener that publishes during a tick queues behind the cached entries', t => {
  const B = stub('B', { up: false });
  const { pool, cached, tick } = rig(t, [B]);
  pool.publish({ n: 1 }, () => [B]);
  pool.publish({ n: 2 });
  pool.publish({ n: 3 });
  let once = true;
  pool.on('error', () => { if (once) { once = false; pool.publish({ n: 99 }); } });
  tick();
  assert.deepStrictEqual(cached(), [1, 2, 3, 99]);
});

test('an \'all\' entry that fails on one channel on a retry keeps its place', t => {
  const [A, B] = [stub('A', { up: false }), stub('B', { up: false })];
  const { pool, cached, tick } = rig(t, [A, B]);
  pool.publish({ n: 1 }, 'all');
  pool.publish({ n: 2 });
  A.up = true;
  Object.assign(B, { up: true, failures: 1 });
  tick();
  assert.deepStrictEqual({ A: A.got, cache: cached() }, { A: [1], cache: [1, 2] });
});

test('a tick still delivers one cached message, the oldest a channel takes', t => {
  const A = stub('A', { up: false });
  const { pool, tick } = rig(t, [A]);
  for (const n of [1, 2, 3]) pool.publish({ n });
  A.up = true;
  tick();
  assert.deepStrictEqual(A.got, [1]);
});

test('an empty cache: a tick publishes nothing and emits nothing', t => {
  const A = stub('A');
  const { heard, tick } = rig(t, [A]);
  tick(3);
  assert.deepStrictEqual({ tries: A.tries, heard }, { tries: 0, heard: { error: [], info: [] } });
});

test('a pool with no channel at all: the tick leaves the cache alone', t => {
  const { pool, cached, heard, tick } = rig(t, []);
  let calls = 0;
  pool.publish({ n: 1 }, () => { calls++; return null; });
  tick(3);
  assert.deepStrictEqual({ calls, cache: cached(), errors: heard.error.length },
    { calls: 1, cache: [1], errors: 0 });
});

test('a listener that publishes on a publish() failure queues behind the failed message', t => {
  const B = stub('B', { up: false });
  const { pool, cached } = rig(t, [B]);
  let once = true;
  pool.on('error', () => { if (once) { once = false; pool.publish({ n: 99 }, () => [B]); } });
  pool.publish({ n: 1 }, () => [B]);
  assert.deepStrictEqual(cached(), [1, 99]);
});
