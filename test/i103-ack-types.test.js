'use strict';
// #103's types, compiled with the project's tsc as test/types.test.js does. Skipped only when
// typescript is not installed.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
let tsc;
try {
  const pkgPath = require.resolve('typescript/package.json', { paths: [root] });
  tsc = path.join(path.dirname(pkgPath), 'bin', 'tsc');
} catch (e) { tsc = null; }
const skip = tsc ? false : 'typescript is not installed';
const flags = ['--strict', '--noEmit', '--module', 'commonjs', '--target', 'es2022',
  '--types', 'node'];

test('types #103: Channel ack() and nack() return boolean', { skip }, () => {
  const result = spawnSync(process.execPath,
    [tsc, ...flags, path.join(__dirname, 'types', 'i103-ack.ts')],
    { cwd: root, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
});
