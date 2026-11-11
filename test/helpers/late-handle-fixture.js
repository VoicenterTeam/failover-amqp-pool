// Run by r2-i-own.test.js as `node <this file>`, one process: the #93 shape. The first row
// times out, and its body opens a handle once the row has ended and its after hooks have all
// run. That handle keeps the event loop alive unless own() releases it. The body resumes when
// the next row starts, so the order is fixed by the runner, not raced on a clock.
const { test } = require('node:test');
const { own } = require('./own');

let nextRowStarted;
const rowEnded = new Promise(resolve => { nextRowStarted = resolve; });

test('a row that opens a handle after it ended', { timeout: 50 }, async t => {
  await rowEnded;
  // 20 s, past the 8 s the caller waits: a broken own() reds there, and this still ends
  const handle = setTimeout(() => {}, 20000);
  await own(t, () => clearTimeout(handle));
});

test('the next row', () => nextRowStarted());
