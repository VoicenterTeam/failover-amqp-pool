// #88: a message is cached once, however many of its channels fail, and a retry goes only to
// the channels that have not taken it. The retry tick reports one failure a tick, and stops
// publishing once the pool is stopped. Stub channels, mock ticks.
const { test } = require('node:test');
const assert = require('node:assert');
const { stub, rig } = require('./r2-e-rig');

const down = name => stub(name, { up: false });

test('[up, down, down]: the live channel gets the message once across 8 ticks', t => {
  const [A, B, C] = [stub('A'), down('B'), down('C')];
  const { pool, tick } = rig(t, [A, B, C]);
  pool.publish({ n: 1 }, () => [A, B, C]);
  tick(8);
  assert.deepStrictEqual(A.got, [1]);
});

test('[down, down]: one message keeps one cache entry over 8 ticks', t => {
  const [B, C] = [down('B'), down('C')];
  const { pool, cached, tick } = rig(t, [B, C]);
  pool.publish({ n: 1 }, () => [B, C]);
  const sizes = [cached().length];
  for (let i = 0; i < 8; i++) { tick(); sizes.push(cached().length); }
  assert.deepStrictEqual(sizes, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

test('a retry goes only to the channels that have not taken the message', t => {
  const [B, C] = [down('B'), down('C')];
  const { pool, cached, tick } = rig(t, [B, C]);
  pool.publish({ n: 1 }, () => [B, C]);
  B.up = true;
  tick(2);
  C.up = true;
  tick(2);
  assert.deepStrictEqual({ B: B.got, C: C.got, cache: cached() }, { B: [1], C: [1], cache: [] });
});

test('an entry with two down channels reports one error a tick', t => {
  const [B, C] = [down('B'), down('C')];
  const { pool, heard, tick } = rig(t, [B, C]);
  pool.publish({ n: 1 }, () => [B, C]);
  heard.error.length = 0;
  tick();
  assert.strictEqual(heard.error.length, 1);
});

test('N entries on one down channel: one error, one channel publish, N filter calls a tick',
  t => {
    const N = 50;
    const B = down('B');
    const { pool, heard, cached, tick } = rig(t, [B]);
    let calls = 0;
    for (let n = 0; n < N; n++) pool.publish({ n }, () => { calls++; return [B]; });
    [calls, B.tries, heard.error.length] = [0, 0, 0];
    tick(5);
    assert.deepStrictEqual({ errors: heard.error.length, tries: B.tries, size: cached().length },
      { errors: 5, tries: 5, size: N });
    assert.ok(calls <= 5 * N, `filter calls ${calls} over 5 ticks`);
  });

test('a channel that failed in a tick takes a direct publish after it comes up', t => {
  const B = down('B');
  const { pool, cached, tick } = rig(t, [B]);
  pool.publish({ n: 'X' }, () => [B]);
  tick();
  B.up = true;
  pool.publish({ n: 'D' }, () => [B]);
  assert.deepStrictEqual({ B: B.got, cache: cached() }, { B: ['D'], cache: ['X'] });
});

test('a channel that failed in one tick is tried again in the next', t => {
  const B = stub('B', { failures: 2 });
  const { pool, cached, tick } = rig(t, [B]);
  pool.publish({ n: 1 }, () => [B]);
  tick(2);
  assert.deepStrictEqual({ B: B.got, cache: cached() }, { B: [1], cache: [] });
});

test('a filter returning [] on a retry drops its entry and says nothing', t => {
  const B = down('B');
  const { pool, heard, cached, tick } = rig(t, [B]);
  let first = true;
  pool.publish({ n: 1 }, () => (first ? (first = false, null) : []));
  tick();
  assert.deepStrictEqual({ cache: cached(), heard },
    { cache: [], heard: { error: [], info: [] } });
});

test('a channel publish that stops the pool ends the attempt: no channel after it gets it',
  t => {
    const [A, B] = [down('A'), down('B')];
    const { pool, tick } = rig(t, [A, B]);
    pool.publish({ n: 1 }, () => [B, A]);
    A.up = true;
    B.publish = () => { pool.stop(); throw new Error('B is dead'); };
    tick();
    assert.deepStrictEqual(A.got, []);
  });

test('an error listener that stops the pool mid-tick: no throw, no publish after it', t => {
  const B = down('B');
  const { pool, tick } = rig(t, [B]);
  pool.publish({ n: 1 }, () => [B]);
  pool.publish({ n: 2 }, () => [B]);
  pool.on('error', () => pool.stop());
  B.tries = 0;
  assert.doesNotThrow(() => tick(5));
  assert.strictEqual(B.tries, 1);
});

test('[down, closed]: each entry tells the closed channel\'s drop once, not on every tick', t => {
  const [A, B] = [down('A'), stub('B', { closed: true })];
  const { pool, heard, tick } = rig(t, [A, B]);
  pool.publish({ n: 1 }, () => [A, B]);
  pool.publish({ n: 2 }, () => [A, B]);
  tick(3);
  assert.deepStrictEqual(heard.info.map(info => info.channelId), ['B', 'B']);
});

test('a pool stopped mid-tick calls no filter after it', t => {
  const B = down('B');
  const { pool, tick } = rig(t, [B]);
  let calls = 0;
  const toB = () => { calls++; return [B]; };
  pool.publish({ n: 1 }, toB);
  pool.publish({ n: 2 }, toB);
  B.publish = () => { pool.stop(); throw new Error('B is dead'); };
  calls = 0;
  tick();
  assert.strictEqual(calls, 1);
});
