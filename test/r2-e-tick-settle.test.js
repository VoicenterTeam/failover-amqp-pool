// The retry tick settles the cache before it tells anyone, keeps what a listener cached during
// the pass, and tells nothing once a listener stopped the pool. Stub channels, mock ticks.
const { test } = require('node:test');
const assert = require('node:assert');
const { stub, rig } = require('./r2-e-rig');

// null on its first call, so publish() caches the message; throws on every later call
function throwsOnRetry() {
  let calls = 0;
  return () => { if (calls++ === 0) return null; throw new Error('filter boom'); };
}

test('a message a listener caches on an event inside a channel publish stays cached, last', t => {
  const B = stub('B', { up: false });
  const { pool, cached, tick } = rig(t, [B]);
  for (const n of [0, 1, 2]) pool.publish({ n }, () => [B]);
  B.publish = () => {
    pool.emit('error', { message: 'channel is dead!' });
    throw new Error('B is dead');
  };
  let armed = true;
  pool.on('error', e => {
    if (armed && e.message === 'channel is dead!') { armed = false; pool.publish({ n: 99 }); }
  });
  tick();
  assert.deepStrictEqual(cached(), [0, 1, 2, 99]);
});

test('a listener that stops the pool mid-tick hears nothing more from that tick', t => {
  const { pool, heard, tick } = rig(t, [stub('A')]);
  pool.publish({ n: 1 }, throwsOnRetry());
  pool.on('error', () => pool.stop());
  tick();
  assert.deepStrictEqual({ errors: heard.error.length, info: heard.info },
    { errors: 1, info: [] });
});

test('a listener told of a tick\'s drop sees the cache without the dropped entry', t => {
  const { pool, tick } = rig(t, [stub('A')]);
  pool.publish({ n: 1 }, throwsOnRetry());
  const seen = [];
  pool.on('error', () => seen.push(pool.msgCache.length));
  tick();
  assert.deepStrictEqual(seen, [0]);
});

test('a pass walks only what was cached when it began: a listener chain waits a tick', t => {
  const A = stub('A');
  const { pool, cached, tick } = rig(t, [A]);
  const publish = A.publish;
  A.publish = msg => { publish(msg); pool.emit('info', 'published'); };
  const laterA = () => { let calls = 0; return () => (calls++ === 0 ? null : [A]); };
  let made = 0;
  pool.on('info', info => {
    if (info === 'published' && made < 50) pool.publish({ n: ++made }, laterA());
  });
  pool.publish({ n: 0 }, laterA());
  tick();
  const first = { took: [...A.got], cache: cached() };
  tick();
  assert.deepStrictEqual({ first, took: A.got },
    { first: { took: [0], cache: [1] }, took: [0, 1] });
});
