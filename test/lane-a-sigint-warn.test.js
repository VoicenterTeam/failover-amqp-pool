// #67: the SIGINT log warns about an app listener that throws. Node prints an Error's warning a
// tick later, reading its code and detail outside the pool's try, so a getter that throws there
// crashed the process. Each row runs a child that is sent a real SIGINT; no broker.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const CHILD = `
  const Pool = require(process.env.LANE_A_ROOT);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const throwing = () => { throw new Error('getter'); };
  const make = {
    code: () => Object.defineProperty(new Error('listener'), 'code', { get: throwing }),
    detail: () => Object.defineProperty(new Error('listener'), 'detail', { get: throwing }),
    stringCode: () => Object.assign(new Error('listener'), { code: 'E_LANE_A' })
  }[process.env.LANE_A_THROW];
  process.on('warning', (w) => {
    let code;
    try { code = w.code; } catch { code = 'read threw'; }
    out({ warning: w.message, code });
  });
  const pool = new Pool([{
    connection: { host: '127.0.0.1', port: 1, reconnectInterval: 60000 },
    channel: { queue: { name: 'lane-a-sigint' } }
  }]);
  pool.on('error', () => {});
  pool.on('info', (m) => { if (typeof m === 'string') throw make(); });
  pool.on('info', (m) => { if (typeof m === 'string') out({ info: m }); });
  out({ ready: true });
`;

// Runs the child to its end: SIGINT once it is ready, then its lines, exit code and stderr
function run(kind) {
  const child = spawn(process.execPath, ['-e', CHILD], {
    env: { ...process.env, LANE_A_ROOT: path.resolve(__dirname, '..'), LANE_A_THROW: kind }
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => {
    if (!out.includes('"ready"') && (out + d).includes('"ready"')) child.kill('SIGINT');
    out += d;
  });
  return new Promise((resolve) => child.on('close', (code, signal) => resolve({
    code, signal, err, lines: out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  })));
}
const pick = (lines, key) => lines.filter((l) => key in l);

const unreadable = [
  ['an Error whose code getter throws', 'code'],
  ['an Error whose detail getter throws', 'detail']
];
for (const [name, kind] of unreadable) {
  test(`a listener throwing ${name}: the log finishes and the child exits 0`, async () => {
    const r = await run(kind);
    assert.deepStrictEqual({ code: r.code, signal: r.signal }, { code: 0, signal: null }, r.err);
    assert.strictEqual(pick(r.lines, 'info').length, 1);
    assert.strictEqual(pick(r.lines, 'warning').length, 1);
  });
}

test('an Error whose code getter throws is warned about with the fixed text', async () => {
  const r = await run('code');
  assert.deepStrictEqual(pick(r.lines, 'warning'), [{ warning: 'unprintable value' }]);
});

test('an Error with a string code keeps its message and code in the warning', async () => {
  const r = await run('stringCode');
  assert.deepStrictEqual(pick(r.lines, 'warning'), [{ warning: 'listener', code: 'E_LANE_A' }]);
  assert.strictEqual(r.code, 0);
});
