// #93: a row's body runs on after the row times out. A handle it opens then, with a t.after
// registered then, is never released: node:test runs a test's hooks once, and a hook added later
// is kept silently and never run. own() releases a late handle at once and stops the body.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { own } = require('./helpers/own');

const FIXTURE = path.join(__dirname, 'helpers', 'late-handle-fixture.js');

test('own() on a running test releases once, after the test ends', async t => {
  let released = 0;
  await t.test('row', async t2 => {
    await own(t2, () => { released++; });
    assert.strictEqual(released, 0);
  });
  assert.strictEqual(released, 1);
});

// a connection closed before the queue on it is deleted would fail the delete
test('own() releases in the reverse order of acquiring, each once', async t => {
  const order = [];
  await t.test('row', async t2 => {
    for (const name of ['connection', 'queue', 'pool']) await own(t2, () => { order.push(name); });
  });
  assert.deepStrictEqual(order, ['pool', 'queue', 'connection']);
});

test('own() runs every release when one throws, then reports the throw', async () => {
  const hooks = [];
  const scope = { after: hook => hooks.push(hook) };
  const order = [];
  await own(scope, () => { order.push('a'); });
  await own(scope, () => { throw new Error('release failed'); });
  await own(scope, () => { order.push('c'); });
  const runHooks = async () => { for (const hook of hooks) await hook(); };
  await assert.rejects(runHooks(), { message: 'release failed' });
  assert.deepStrictEqual(order, ['c', 'a']);
});

test('own() on an ended test releases at once and rejects', async () => {
  let released = 0;
  const ended = { after() { throw new Error('a late hook would never run'); },
    signal: AbortSignal.abort() };
  await assert.rejects(own(ended, () => { released++; }),
    { message: 'the test has ended; released a handle it acquired late' });
  assert.strictEqual(released, 1);
});

test('own() checks its arguments and names the bad one', async () => {
  const rows = [
    ['no arguments', [], /^TypeError: own\(t, release\): t /],
    ['t without after()', [{}, () => {}], /^TypeError: own\(t, release\): t /],
    ['no release', [{ after() {} }], /^TypeError: own\(t, release\): release /],
    ['release not a function', [{ after() {} }, 'x'], /^TypeError: own\(t, release\): release /],
  ];
  for (const [name, args, message] of rows) await assert.rejects(own(...args), message, name);
});

// The file-level shape of #93: a row times out, then opens a handle that keeps the loop alive.
test('a file whose row times out and then opens a handle still exits', async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;   // set by an outer node --test; the fixture runs on its own
  const child = spawn(process.execPath, ['--test', FIXTURE], { stdio: 'ignore', env });
  let timer;
  const hung = new Promise(resolve => { timer = setTimeout(resolve, 8000, 'hung'); });
  const ended = new Promise(resolve => child.on('exit', code => resolve({ code })));
  const got = await Promise.race([ended, hung]);
  clearTimeout(timer);
  if (got === 'hung') child.kill('SIGKILL');
  assert.deepStrictEqual(got, { code: 1 });   // 1: the timed-out row fails, the file ends
});
