// #36: a Channel closed with close() but still listed is final: a cached entry aimed only at it
// is dropped with one 'info', as a removed channel's is. Stub channels; timers are node:test
// mock timers, so start()'s own retry tick runs the path.
const { test } = require('node:test');
const assert = require('node:assert');
const { fake, rig } = require('./helpers/stubpool');

// B fails once under 'all', so its entry is cached with the retry filter; start() retries it
function cachedForB(t, B, props) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const A = fake('A');
  const env = rig(t, { alive: [A, B], all: [A, B] });
  env.pool.publish({ n: 1 }, 'all', undefined, props);
  assert.strictEqual(env.pool.msgCache.length, 1);
  env.setAlive([A]);
  env.pool.start(10);
  return { A, ...env };
}

test('start() retry: an entry aimed only at a closed, listed channel is dropped with one info',
  t => {
    const B = fake('B', { failures: 1 });
    const { pool, heard } = cachedForB(t, B);
    B.isClosed = true;
    t.mock.timers.tick(10);
    assert.strictEqual(pool.msgCache.length, 0);
    assert.deepStrictEqual(heard.info.map(e => [e.message, e.channelId, e.reason]),
      [['cached message dropped', 'B', 'channel is closed']]);
    assert.deepStrictEqual(heard.error, []);
    t.mock.timers.tick(30);
    assert.strictEqual(heard.info.length, 1, 'dropped once, not per tick');
  });

test('the drop info carries the message\'s messageId, as \'stale ack dropped\' does', t => {
  const B = fake('B', { failures: 1 });
  const { heard } = cachedForB(t, B, { messageId: 'm-1' });
  B.isClosed = true;
  t.mock.timers.tick(10);
  assert.deepStrictEqual(heard.info, [{
    message: 'cached message dropped', messageId: 'm-1', channelId: 'B',
    reason: 'channel is closed'
  }]);
});

test('a closed channel\'s entry reaches no other channel', t => {
  const B = fake('B', { failures: 1 });
  const { pool, A } = cachedForB(t, B);
  B.isClosed = true;
  t.mock.timers.tick(10);
  assert.deepStrictEqual([A.got.length, B.got.length, pool.msgCache.length], [1, 0, 0]);
});

test('start() retry: a down channel that is not closed keeps its entry and says nothing', t => {
  const B = fake('B', { failures: 1 });
  const { pool, heard } = cachedForB(t, B);
  t.mock.timers.tick(10);
  t.mock.timers.tick(10);
  assert.strictEqual(pool.msgCache.length, 1);
  assert.deepStrictEqual(heard.info, []);
});

test('start() retry: a channel with no isClosed at all reads as not closed', t => {
  const B = fake('B', { failures: 1 });
  delete B.isClosed;
  const { pool } = cachedForB(t, B);
  t.mock.timers.tick(10);
  assert.strictEqual(pool.msgCache.length, 1);
});

test('start() retry: a channel closed and then removed drops its entry, as a removed one does',
  t => {
    const B = fake('B', { failures: 1 });
    const { pool, setAll, A, heard } = cachedForB(t, B);
    B.isClosed = true;
    setAll([A]);
    t.mock.timers.tick(10);
    assert.strictEqual(pool.msgCache.length, 0);
    assert.deepStrictEqual(heard.info, [], 'a removed channel stays silent');
  });

test('the closed channel\'s entry is dropped though the pool\'s only channel is closed', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const B = fake('B', { failures: 1 });
  const { pool, setAlive, heard } = rig(t, { alive: [B], all: [B] });
  pool.publish({ n: 1 }, 'all');
  pool.publish({ n: 2 }, () => null);
  setAlive([]);
  B.isClosed = true;
  pool.start(10);
  t.mock.timers.tick(10);
  assert.strictEqual(pool.msgCache.length, 1, 'the retry filter entry is gone, the other waits');
  assert.strictEqual(heard.info.length, 1);
});

test('one entry is dropped, the entry of a down channel beside it stays', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const [A, B, C] = [fake('A'), fake('B', { failures: 1 }), fake('C', { failures: 1 })];
  const { pool, setAlive, heard } = rig(t, { alive: [A, B, C], all: [A, B, C] });
  pool.publish({ n: 1 }, 'all');
  assert.strictEqual(pool.msgCache.length, 2);
  setAlive([A]);
  B.isClosed = true;
  pool.start(10);
  t.mock.timers.tick(20);
  assert.strictEqual(pool.msgCache.length, 1, 'C waits, B is gone');
  assert.deepStrictEqual(heard.info.map(e => e.channelId), ['B']);
});
