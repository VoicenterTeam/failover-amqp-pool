// Ties a handle a row acquired to the row, however the row ends (#93). node:test runs a test's
// after hooks once, when the test ends or times out, and a hook added after that never runs. A
// timed-out row's body runs on, so a pool or connection it opens late would outlive the file and
// keep its event loop alive. own() keeps the row's releases on one after hook, which runs them
// last acquired first, every one even when one throws. Once the test's signal has aborted, own()
// calls `release` at once and rejects, which ends the body.
const stacks = new WeakMap();

async function releaseAll(stack) {
  let failed;
  while (stack.length) {
    try { await stack.pop()(); } catch (e) { failed ??= { e }; }
  }
  if (failed) throw failed.e;
}

async function own(t, release) {
  if (typeof t?.after !== 'function') {
    throw new TypeError('own(t, release): t must be a test context with after()');
  }
  if (typeof release !== 'function') {
    throw new TypeError('own(t, release): release must be a function');
  }
  if (!t.signal?.aborted) {
    if (!stacks.has(t)) {
      const stack = [];
      stacks.set(t, stack);
      t.after(() => releaseAll(stack));
    }
    stacks.get(t).push(release);
    return;
  }
  await release();
  throw new Error('the test has ended; released a handle it acquired late');
}

module.exports = { own };
