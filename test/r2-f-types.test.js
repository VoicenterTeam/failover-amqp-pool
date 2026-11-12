'use strict';
// #79's types, compiled with the project's tsc as test/types.test.js does. Skipped only when
// typescript is not installed.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
let tsc;
try {
  const pkgPath = require.resolve('typescript/package.json', { paths: [root] });
  tsc = path.join(path.dirname(pkgPath), 'bin', 'tsc');
} catch (e) { tsc = null; }
const skip = tsc ? false : 'typescript is not installed';
const flags = ['--strict', '--noEmit', '--module', 'commonjs', '--target', 'es2022',
  '--types', 'node'];
const compile = file => {
  const result = spawnSync(process.execPath, [tsc, ...flags, path.join(__dirname, 'types', file)],
    { cwd: root, encoding: 'utf8' });
  return { status: result.status, out: result.stdout + result.stderr };
};

test('types #79: unconfirmed entries, waitConfirmed, resend and stop options compile', { skip },
  () => {
    const { status, out } = compile('r2-f-usage.ts');
    assert.strictEqual(status, 0, out);
  });

test('types #79: each r2-f-negative.ts misuse raises its tagged error only', { skip }, () => {
  const lines = fs.readFileSync(path.join(__dirname, 'types', 'r2-f-negative.ts'), 'utf8')
    .split('\n');
  const expected = [];
  lines.forEach((text, i) => {
    const tag = /\/\/ (TS\d+)/.exec(text);
    if (tag) expected.push(`${i + 1} ${tag[1]}`);
  });
  const { out } = compile('r2-f-negative.ts');
  const got = [...out.matchAll(/r2-f-negative\.ts\((\d+),\d+\): error (TS\d+)/g)]
    .map(m => `${m[1]} ${m[2]}`);
  assert.strictEqual(expected.length, 6);
  assert.deepStrictEqual(got, expected, out);
});
