// One way into the cache: #cache pushes each entry the pool adds, and nothing else pushes. An
// 'all' entry split on a retry enters there too; an entry put back in its place is not added
// again. Seen through a msgCache whose push records what it is given. Stub channels, mock ticks.
const { test } = require('node:test');
const assert = require('node:assert');
const { stub, rig } = require('./r2-e-rig');

function recording(pool) {
  const added = [];
  const cache = [];
  cache.push = (...entries) => {
    added.push(...entries.map(entry => entry.msg.n));
    return Array.prototype.push.apply(cache, entries);
  };
  pool.msgCache = cache;
  return added;
}

test('every entry enters the cache once, through one way in, an \'all\' split too', t => {
  const [A, B, C] = [stub('A', { up: false }), stub('B', { up: false }), stub('C', { up: false })];
  const { pool, cached, tick } = rig(t, [A, B, C]);
  const added = recording(pool);
  pool.publish({ n: 0 }, () => [C]);
  pool.publish({ n: 1 }, 'all');
  A.up = true;
  Object.assign(B, { up: true, failures: 1 });
  tick();
  assert.deepStrictEqual({ added, cache: cached() }, { added: [0, 1, 1], cache: [0, 1] });
});
