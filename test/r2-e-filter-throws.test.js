// #89: a function filter that throws while the retry tick retries its message. The tick catches
// it, emits 'error' with the thrown value, and drops that message with one 'info'. A throw on
// publish() itself still reaches the caller. Stub channels, mock ticks; one child-process row.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stub, rig } = require('./r2-e-rig');

// null on its first call, so publish() caches the message; throws on every later call
function throwsOnRetry(error) {
  let calls = 0;
  return () => { if (calls++ === 0) return null; throw error; };
}

test('a filter that throws in a tick: its error is emitted once, the tick does not throw', t => {
  const boom = new Error('filter boom');
  const { pool, heard, tick } = rig(t, [stub('A')]);
  pool.publish({ n: 1 }, throwsOnRetry(boom));
  assert.doesNotThrow(() => tick(3));
  assert.deepStrictEqual(heard.error, [boom]);
});

test('the throwing filter\'s message is dropped with one info naming the reason', t => {
  const { pool, heard, cached, tick } = rig(t, [stub('A')]);
  pool.publish({ n: 1 }, throwsOnRetry(new Error('filter boom')), undefined,
    { messageId: 'm-1' });
  tick(3);
  assert.deepStrictEqual({ cache: cached(), info: heard.info }, { cache: [], info: [
    { message: 'cached message dropped', messageId: 'm-1', reason: 'filter threw' }] });
});

test('a throwing filter does not hold back the entry behind it', t => {
  const A = stub('A', { up: false });
  const { pool, tick } = rig(t, [A]);
  pool.publish({ n: 'T' }, throwsOnRetry(new Error('filter boom')));
  pool.publish({ n: 'Y' });
  A.up = true;
  tick();
  assert.deepStrictEqual(A.got, ['Y']);
});

test('a filter that throws on publish() itself still throws to the caller, caching nothing',
  t => {
    const { pool, cached } = rig(t, [stub('A')]);
    assert.throws(() => pool.publish({ n: 1 }, () => { throw new Error('filter boom'); }),
      { message: 'filter boom' });
    assert.deepStrictEqual(cached(), []);
  });

// The child exits 0 once it heard the drop info; an uncaught throw from the tick exits 1 first
const CHILD = `
const Connection = require(${JSON.stringify(path.join(__dirname, '..', 'Connection'))});
Connection.prototype.start = function () {};
const AMQPPool = require(${JSON.stringify(path.join(__dirname, '..'))});
const pool = new AMQPPool([{ connection: { host: '127.0.0.1', port: 5672 }, channel: {} }]);
const A = { _id: 'A', isClosed: false, publish() {} };
pool.getAllChannels = () => [A];
pool.getAliveChannels = () => [A];
const errors = [];
pool.on('error', e => errors.push(e.message));
pool.on('info', async info => {
  await pool.stop();
  console.log(JSON.stringify({ errors, info }));
});
let calls = 0;
pool.publish({ n: 1 }, () => { if (calls++ === 0) return null; throw new Error('filter boom'); },
  undefined, { messageId: 'm-1' });
pool.start(1);
`;

test('child process: a filter throwing in a real tick does not crash it', () => {
  const r = spawnSync(process.execPath, ['-e', CHILD], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { errors: ['filter boom'], info: {
    message: 'cached message dropped', messageId: 'm-1', reason: 'filter threw' } });
});
