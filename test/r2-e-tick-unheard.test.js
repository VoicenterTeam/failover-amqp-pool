// #89 with nobody listening: the retry tick runs in a timer, so an 'error' with no listener, or a
// listener's throw, becomes a process warning instead of an uncaught exception. Stub channels,
// mock ticks, process.emitWarning mocked; one child-process row with real timers.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stub, rig } = require('./r2-e-rig');

function throwsOnRetry() {
  let calls = 0;
  return () => { if (calls++ === 0) return null; throw new Error('filter boom'); };
}
const warned = t => {
  const mock = t.mock.method(process, 'emitWarning', () => {});
  return () => mock.mock.calls.map(call => call.arguments[0].message);
};

test('no error listener: a filter throwing in a tick is warned about, the tick does not throw',
  t => {
    const { pool, cached, tick } = rig(t, [stub('A')]);
    pool.publish({ n: 1 }, throwsOnRetry());
    pool.removeAllListeners('error');
    const warnings = warned(t);
    assert.doesNotThrow(() => tick(3));
    assert.deepStrictEqual({ warnings: warnings(), cache: cached() },
      { warnings: ['filter boom'], cache: [] });
  });

test('no error listener: a channel failing in a tick is warned about, the tick does not throw',
  t => {
    const A = stub('A', { failures: 2 });
    const { pool, tick } = rig(t, [A]);
    pool.publish({ n: 1 });
    pool.removeAllListeners('error');
    const warnings = warned(t);
    assert.doesNotThrow(() => tick());
    assert.deepStrictEqual(warnings(), ['A is dead']);
  });

test('an error listener that throws in a tick is warned about, and the info still goes out',
  t => {
    const { pool, heard, tick } = rig(t, [stub('A')]);
    pool.publish({ n: 1 }, throwsOnRetry());
    pool.on('error', () => { throw new Error('listener boom'); });
    const warnings = warned(t);
    assert.doesNotThrow(() => tick());
    assert.deepStrictEqual({ warnings: warnings(), info: heard.info.length },
      { warnings: ['listener boom'], info: 1 });
  });

// No 'error' listener. The child prints the warning and exits 0; an uncaught throw exits 1 first.
const CHILD = `
const Connection = require(${JSON.stringify(path.join(__dirname, '..', 'Connection'))});
Connection.prototype.start = function () {};
const AMQPPool = require(${JSON.stringify(path.join(__dirname, '..'))});
const pool = new AMQPPool([{ connection: { host: '127.0.0.1', port: 5672 }, channel: {} }]);
const A = { _id: 'A', isClosed: false, publish() {} };
pool.getAllChannels = () => [A];
pool.getAliveChannels = () => [A];
process.on('warning', async warning => {
  await pool.stop();
  console.log(JSON.stringify({ warning: warning.message, cached: pool.msgCache.length }));
});
let calls = 0;
pool.publish({ n: 1 }, () => { if (calls++ === 0) return null; throw new Error('filter boom'); });
pool.start(1);
`;

test('child process, no error listener: a filter throwing in a real tick is no crash', () => {
  const r = spawnSync(process.execPath, ['-e', CHILD], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { warning: 'filter boom', cached: 0 });
});
