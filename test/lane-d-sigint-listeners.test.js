// #44: test files stop the pools they build, so the SIGINT listeners each pool adds are gone
// when the file ends and never pile up toward Node's limit of 10. Each row runs a test file on
// its own, offline, with a preload that records the listener count (helpers/sigint-probe.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const root = path.join(__dirname, '..');

// runs one test file (optionally one row of it) and returns the probe's record
async function probe(t, file, pattern) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lane-d-sigint-${process.pid}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'record.json');
  const env = { ...process.env, LANE_D_SIGINT_OUT: out };
  for (const k of Object.keys(env)) {
    if (k === 'NODE_TEST_CONTEXT' || k.startsWith('FAMQP_TEST_')) delete env[k];
  }
  const args = ['--require', './test/helpers/sigint-probe.js'];
  if (pattern) args.push(`--test-name-pattern=${pattern}`);
  await execFile(process.execPath, [...args, path.join('test', file)], { cwd: root, env });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

for (const file of ['amqplib2.test.js', 'channel.unit.test.js']) {
  test(`#44 ${file} ends with the SIGINT listener count it started with`, async t => {
    const { before, after } = await probe(t, file);
    assert.strictEqual(after, before);
  });
}

test('#44 the heartbeat row holds one pool, so one SIGINT listener, at a time', async t => {
  const { before, peak } = await probe(t, 'amqplib2.test.js', 'heartbeat');
  assert.strictEqual(peak - before, 1);
});
