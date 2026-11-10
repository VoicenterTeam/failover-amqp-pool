'use strict';
// Compiles test/types/*.ts against index.d.ts with the project's tsc. Skipped only when
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

function compile(files, extra = []) {
  const sources = files.map(f => path.join(__dirname, 'types', f));
  const result = spawnSync(process.execPath, [tsc, ...flags, ...extra, ...sources],
    { cwd: root, encoding: 'utf8' });
  return { status: result.status, out: result.stdout + result.stderr };
}

const rows = [
  ['import = require, events, stop(), sendToQueue, no exchange type', ['usage-require.ts'], []],
  ['default import under esModuleInterop', ['usage-interop.ts'], ['--esModuleInterop']],
];
for (const [name, files, extra] of rows) {
  test(`types: ${name}`, { skip }, () => {
    const { status, out } = compile(files, extra);
    assert.strictEqual(status, 0, out);
  });
}

test('types: the README TypeScript snippet compiles', { skip }, () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const snippet = /```typescript\n([\s\S]*?)```/.exec(readme)[1];
  const name = `readme-snippet-${process.pid}.ts`;
  const file = path.join(__dirname, 'types', name);
  fs.writeFileSync(file, snippet.split('@voicenter-team/failover-amqp-pool').join('../..'));
  try {
    const { status, out } = compile([name]);
    assert.strictEqual(status, 0, out);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('types: each negative.ts misuse raises its tagged error only', { skip }, () => {
  const negative = path.join(__dirname, 'types', 'negative.ts');
  const lines = fs.readFileSync(negative, 'utf8').split('\n');
  const expected = [];
  lines.forEach((text, i) => {
    const tag = /\/\/ (TS\d+)/.exec(text);
    if (tag) expected.push(`${i + 1} ${tag[1]}`);
  });
  const { out } = compile(['negative.ts']);
  const errors = out.matchAll(/negative\.ts\((\d+),\d+\): error (TS\d+)/g);
  const got = [...errors].map(m => `${m[1]} ${m[2]}`);
  assert.ok(expected.length >= 9);
  assert.deepStrictEqual(got, expected, out);
});

test('types: package.json points types at a packed file', () => {
  const pkg = require('../package.json');
  assert.strictEqual(pkg.types, 'index.d.ts');
  assert.ok(pkg.files.includes(pkg.types));
  assert.ok(fs.existsSync(path.join(root, pkg.types)));
});

test('types: winston-transport is an optional peer and nanoid is not a dependency', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.peerDependencies['winston-transport']);
  assert.deepStrictEqual(pkg.peerDependenciesMeta['winston-transport'], { optional: true });
  assert.ok(!pkg.peerDependenciesMeta['@opentelemetry/api']);
  assert.ok(!('nanoid' in pkg.dependencies));
});
