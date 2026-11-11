// #71: a function filter that returns a channel closed with close() can never reach it, so the
// entry is dropped with one 'info' per closed channel, the shape #36 gives an 'all' drop. A down
// channel that is not closed keeps its entry. Stub channels, node:test mock timers.
const { test } = require('node:test');
const assert = require('node:assert');
const { fake, rig } = require('./helpers/stubpool');

function started(t, channels) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const env = rig(t, { alive: [], all: channels });
  env.pool.start(10);
  return env;
}
const drop = (messageId, channelId) => ({
  message: 'cached message dropped', messageId, channelId, reason: 'channel is closed'
});

test('a filter returning only a closed channel drops the entry with one info', t => {
  const B = fake('B', { closed: true });
  const { pool, heard } = started(t, [B]);
  pool.publish({ n: 1 }, () => [B], undefined, { messageId: 'm-1' });
  t.mock.timers.tick(30);
  assert.strictEqual(pool.msgCache.length, 0);
  assert.deepStrictEqual(heard.info, [drop('m-1', 'B')]);
  assert.deepStrictEqual(heard.error, []);
});

test('a channel closed after its entry was cached drops it on the next retry, once', t => {
  const B = fake('B', { failures: 1 });
  const { pool, heard } = started(t, [B]);
  pool.publish({ n: 1 }, () => [B]);
  assert.strictEqual(pool.msgCache.length, 1);
  B.isClosed = true;
  t.mock.timers.tick(30);
  assert.strictEqual(pool.msgCache.length, 0);
  assert.deepStrictEqual(heard.info, [drop(undefined, 'B')]);
});

test('a filter returning two closed channels drops the entry with one info for each', t => {
  const [B, C] = [fake('B', { closed: true }), fake('C', { closed: true })];
  const { pool, heard } = started(t, [B, C]);
  pool.publish({ n: 1 }, () => [B, C]);
  t.mock.timers.tick(30);
  assert.strictEqual(pool.msgCache.length, 0);
  assert.deepStrictEqual(heard.info.map(e => e.channelId), ['B', 'C']);
});

test('an open channel beside a closed one gets the message once, never again by a retry', t => {
  const [A, B] = [fake('A'), fake('B', { closed: true })];
  const { pool, heard } = started(t, [A, B]);
  pool.publish({ n: 1 }, () => [A, B]);
  t.mock.timers.tick(30);
  assert.deepStrictEqual([A.got.length, B.got.length, pool.msgCache.length], [1, 0, 0]);
  assert.deepStrictEqual(heard.info.map(e => e.channelId), ['B']);
});

test('a down channel that is not closed keeps its entry and says nothing', t => {
  const B = fake('B', { failures: 10 });
  const { pool, heard } = started(t, [B]);
  pool.publish({ n: 1 }, () => [B]);
  t.mock.timers.tick(30);
  assert.strictEqual(pool.msgCache.length, 1);
  assert.deepStrictEqual(heard.info, []);
});

test('a channel with no isClosed at all reads as not closed', t => {
  const B = fake('B', { failures: 10 });
  delete B.isClosed;
  const { pool } = started(t, [B]);
  pool.publish({ n: 1 }, () => [B]);
  t.mock.timers.tick(30);
  assert.strictEqual(pool.msgCache.length, 1);
});

test('a filter returning null in its list does not throw out of publish()', t => {
  const { pool, heard } = started(t, []);
  assert.doesNotThrow(() => pool.publish({ n: 1 }, () => [null]));
  assert.deepStrictEqual([pool.msgCache.length, heard.info.length], [1, 0]);
});
