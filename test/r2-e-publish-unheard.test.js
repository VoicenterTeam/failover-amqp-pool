// A publish() call whose channel fails. With nobody listening for 'error', the error is thrown to
// the caller, as before, and nothing is cached, so a caller that publishes again sends it once.
// With a listener, the message is cached first and the listener hears the error after. Stubs.
const { test } = require('node:test');
const assert = require('node:assert');
const { stub, rig } = require('./r2-e-rig');

test('no error listener: a failed publish() throws its error and caches nothing', t => {
  const { pool, cached } = rig(t, [stub('A', { failures: 1 })]);
  pool.removeAllListeners('error');
  assert.throws(() => pool.publish({ n: 1 }), { message: 'A is dead' });
  assert.deepStrictEqual(cached(), []);
});

test('an error listener: a failed publish() caches the message, then the listener hears it', t => {
  const { pool, heard, cached } = rig(t, [stub('A', { failures: 1 })]);
  const seen = [];
  pool.on('error', () => seen.push(cached()));
  pool.publish({ n: 1 });
  assert.deepStrictEqual({ seen, errors: heard.error.length }, { seen: [[1]], errors: 1 });
});
