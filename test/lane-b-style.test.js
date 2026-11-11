// #64: Channel.js keeps every line at 99 characters or fewer, and assigns one target per
// statement (no `a = b = c`).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const lines = fs.readFileSync(path.join(__dirname, '..', 'Channel.js'), 'utf8').split('\n');
const where = (pick) => lines.map((l, i) => [i + 1, l]).filter(([, l]) => pick(l));

test('#64 no line in Channel.js is over 99 characters', () => {
  assert.deepStrictEqual(where(l => l.length > 99).map(([n, l]) => [n, l.length]), []);
});

// an assignment whose value is itself an assignment: `= name =` not followed by `=` or `>`
const chained = /[^=!<>]=\s*[\w.#]+\s*=(?![=>])/;

test('#64 the chained-assignment pattern finds a chain and passes a comparison', () => {
  assert.ok(chained.test('const checked = this.#checking = this.amqpChannel;'));
  assert.ok(!chained.test('const same = a === b; const f = x => x; let y = 1, z = 2;'));
});

test('#64 Channel.js has no chained assignment', () => {
  assert.deepStrictEqual(where(l => chained.test(l)).map(([n]) => n), []);
});
