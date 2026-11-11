// Run by r2-i-own.test.js as `node --test <this file>`: the #93 shape. The first row times out,
// and its body opens a handle once the row has ended and its after hooks have all run. That
// handle keeps the event loop alive unless own() releases it. The body resumes when the next
// row starts, so the order is fixed by the runner, not raced on a clock.
const { test } = require('node:test');
const { own } = require('./own');

let nextRowStarted;
const rowEnded = new Promise(resolve => { nextRowStarted = resolve; });

test('a row that opens a handle after it ended', { timeout: 50 }, async t => {
  await rowEnded;
  const handle = setInterval(() => {}, 1000);
  await own(t, () => clearInterval(handle));
});

test('the next row', () => nextRowStarted());
