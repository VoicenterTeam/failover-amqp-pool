// Under the 'all' filter a failed publish is retried on the channel that failed, not on every
// channel. The retry is driven the way start() does it: shift an entry from msgCache and call
// publish with its fields.
const { test } = require('node:test');
const assert = require('node:assert');
const Connection = require('../Connection');
const AMQPPool = require('..');

const realStart = Connection.prototype.start;
function offlinePool(t, channels) {
  Connection.prototype.start = function () {};
  t.after(() => { Connection.prototype.start = realStart; });
  const pool = new AMQPPool([{ connection: { host: '127.0.0.1', port: 5672 }, channel: {} }]);
  const errors = [];
  pool.on('error', e => errors.push(e));
  pool.alive = channels.slice();
  pool.all = channels.slice();
  pool.getAliveChannels = () => pool.alive.slice();
  pool.getAllChannels = () => pool.all.slice();
  return { pool, errors };
}
function fake(name, failures = 0) {
  const ch = { name, got: [], failures, _id: name,
    publish(msg) {
      if (ch.failures > 0) { ch.failures--; throw new Error(`${name} is dead`); }
      ch.got.push(msg);
    } };
  return ch;
}
function retry(pool) {
  const m = pool.msgCache.shift();
  pool.publish(m.msg, m.filter, m.topic, m.props);
}
const counts = (...chs) => chs.map(c => c.got.length);

test('all: A ok, B fails once, retry reaches B only', t => {
  const [A, B] = [fake('A'), fake('B', 1)];
  const { pool } = offlinePool(t, [A, B]);
  pool.publish({ n: 1 }, 'all');
  assert.strictEqual(pool.msgCache.length, 1);
  retry(pool);
  assert.deepStrictEqual(counts(A, B), [1, 1]);
  assert.strictEqual(pool.msgCache.length, 0);
});

test('all: two channels fail, two entries, each retry reaches only its own channel', t => {
  const [A, B, C] = [fake('A', 1), fake('B', 1), fake('C')];
  const { pool } = offlinePool(t, [A, B, C]);
  pool.publish({ n: 1 }, 'all');
  assert.strictEqual(pool.msgCache.length, 2);
  retry(pool);
  assert.deepStrictEqual(counts(A, B, C), [1, 0, 1]);
  retry(pool);
  assert.deepStrictEqual(counts(A, B, C), [1, 1, 1]);
  assert.strictEqual(pool.msgCache.length, 0);
});

test('all: the failed channel is not alive at retry, the entry is re-cached until it is', t => {
  const [A, B] = [fake('A'), fake('B', 1)];
  const { pool } = offlinePool(t, [A, B]);
  pool.publish({ n: 1 }, 'all');
  pool.alive = [A];
  retry(pool);
  assert.strictEqual(pool.msgCache.length, 1);
  assert.deepStrictEqual(counts(A, B), [1, 0]);
  pool.alive = [A, B];
  retry(pool);
  assert.deepStrictEqual(counts(A, B), [1, 1]);
  assert.strictEqual(pool.msgCache.length, 0);
});

test('all: the retry matches the channel object, not its _id, which a re-create changes', t => {
  const [A, B] = [fake('A'), fake('B', 1)];
  const { pool } = offlinePool(t, [A, B]);
  pool.publish({ n: 1 }, 'all');
  B._id = 'B-recreated';
  retry(pool);
  assert.deepStrictEqual(counts(A, B), [1, 1]);
});

test('all: a retry that fails again is cached again for the same channel only', t => {
  const [A, B] = [fake('A'), fake('B', 2)];
  const { pool, errors } = offlinePool(t, [A, B]);
  pool.publish({ n: 1 }, 'all');
  retry(pool);
  assert.strictEqual(pool.msgCache.length, 1);
  retry(pool);
  assert.deepStrictEqual(counts(A, B), [1, 1]);
  assert.strictEqual(errors.length, 0);
});

test('all: a RangeError is reported once and not cached', t => {
  const A = fake('A');
  A.publish = () => { throw new RangeError('too big'); };
  const { pool, errors } = offlinePool(t, [A]);
  pool.publish({ n: 1 }, 'all');
  assert.strictEqual(pool.msgCache.length, 0);
  assert.strictEqual(errors.length, 1);
});

test('all: no alive channel: whole entry cached once, later retry reaches every channel', t => {
  const [A, B] = [fake('A'), fake('B')];
  const { pool } = offlinePool(t, []);
  pool.publish({ n: 1 }, 'all', 'tp', { p: 1 });
  assert.strictEqual(pool.msgCache.length, 1);
  assert.strictEqual(pool.msgCache[0].filter, 'all');
  pool.alive = [A, B];
  retry(pool);
  assert.deepStrictEqual(counts(A, B), [1, 1]);
  assert.strictEqual(pool.msgCache.length, 0);
});

test('all: every alive channel gets the message exactly once on the first attempt', t => {
  const chs = [fake('A'), fake('B'), fake('C')];
  const { pool } = offlinePool(t, chs);
  pool.publish({ n: 1 }, 'all');
  assert.deepStrictEqual(counts(...chs), [1, 1, 1]);
  assert.strictEqual(pool.msgCache.length, 0);
});

test('all: a channel removed from the pool has its entry dropped, reaching no other channel', t => {
  const [A, B] = [fake('A'), fake('B', 1)];
  const { pool } = offlinePool(t, [A, B]);
  pool.publish({ n: 1 }, 'all');
  pool.all = [A];
  pool.alive = [A];
  retry(pool);
  assert.strictEqual(pool.msgCache.length, 0);
  assert.deepStrictEqual(counts(A, B), [1, 0]);
});

test('first alive: publishes on the first alive channel', t => {
  const [A, B] = [fake('A'), fake('B')];
  const { pool } = offlinePool(t, [A, B]);
  pool.publish({ n: 1 });
  assert.deepStrictEqual(counts(A, B), [1, 0]);
});

test('rr: publishes on alternate channels', t => {
  const [A, B] = [fake('A'), fake('B')];
  const { pool } = offlinePool(t, [A, B]);
  pool.publish({ n: 1 }, 'rr');
  pool.publish({ n: 2 }, 'rr');
  assert.deepStrictEqual(counts(A, B), [1, 1]);
});

test('function filter: publishes on the channels it returns', t => {
  const [A, B] = [fake('A'), fake('B')];
  const { pool } = offlinePool(t, [A, B]);
  pool.publish({ n: 1 }, chs => [chs[1]]);
  assert.deepStrictEqual(counts(A, B), [0, 1]);
});

test('function filter: a failed publish is reported as an error and cached', t => {
  const A = fake('A', 1);
  const { pool, errors } = offlinePool(t, [A]);
  pool.publish({ n: 1 }, chs => [chs[0]]);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(pool.msgCache.length, 1);
});

test('function filter: one carrying an isAllRetry property still reports a failure', t => {
  const A = fake('A', 1);
  const { pool, errors } = offlinePool(t, [A]);
  const filter = chs => [chs[0]];
  filter.isAllRetry = true;
  pool.publish({ n: 1 }, filter);
  assert.strictEqual(errors.length, 1);
});
