// The 'connection' overloads of index.d.ts, compiled with the project's tsc as types.test.js
// does: a listener taking a number is TS2769, one taking the url string compiles. Skipped only
// when typescript is not installed.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
let tsc;
try {
  const pkgPath = require.resolve('typescript/package.json', { paths: [root] });
  tsc = path.join(path.dirname(pkgPath), 'bin', 'tsc');
} catch (e) { tsc = null; }
const skip = tsc ? false : 'typescript is not installed';
const flags = ['--strict', '--noEmit', '--module', 'commonjs', '--target', 'es2022',
  '--types', 'node', '--typeRoots', path.join(root, 'node_modules', '@types')];

function compile(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-a-types-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.ts');
  const head = `import AMQPPool = require(${JSON.stringify(path.join(root, 'index'))});\n`;
  fs.writeFileSync(file, head + 'declare const pool: AMQPPool;\n' + body);
  const r = spawnSync(process.execPath, [tsc, ...flags, file], { cwd: root, encoding: 'utf8' });
  const errors = [...(r.stdout + r.stderr).matchAll(/fixture\.ts\((\d+),\d+\): error (TS\d+)/g)];
  return { status: r.status, errors: errors.map(m => `${m[1]} ${m[2]}`), out: r.stdout };
}

test('types: a connection listener taking a number is TS2769, on() and once()', { skip }, t => {
  const { errors, out } = compile(t, [
    'pool.on(\'connection\', (url: number) => { void url; });',
    'pool.once(\'connection\', (url: number) => { void url; });', ''
  ].join('\n'));
  assert.deepStrictEqual(errors, ['3 TS2769', '4 TS2769'], out);
});

test('types: a connection listener taking the url string compiles', { skip }, t => {
  const { status, out } = compile(t, [
    'pool.on(\'connection\', (url: string) => { void url.length; });',
    'pool.once(\'connection\', (url: string) => { void url.length; });', ''
  ].join('\n'));
  assert.strictEqual(status, 0, out);
});
