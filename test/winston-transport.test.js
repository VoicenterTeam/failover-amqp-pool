// #77: the Winston transport after its pool stops. It warns once, then drops lines; after
// close() it drops them with no warning. Pools never dial out; nothing sleeps.
const { test } = require('node:test');
const assert = require('node:assert');
const { offline } = require('./helpers/offline');
const WinstonAMQPPoolTransport = require('../WinstonAMQPPoolTransport');

const pool = [{ connection: { host: '127.0.0.1', port: 5672 }, channel: {} }];

// A transport, with what it said: process 'warning's, its own 'warn's and console.error calls
function rig(t) {
  offline(t);
  const transport = new WinstonAMQPPoolTransport({ pool, topic: 'logs' });
  // the real stop(), taken before any test mocks it, so the pool's timer always ends
  const stop = transport.client.stop.bind(transport.client);
  t.after(() => stop());
  const heard = { warning: [], warn: [] };
  const onWarning = w => heard.warning.push(w);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  transport.on('warn', e => heard.warn.push(e));
  // node prints a process warning with console.error too, as a string; the transport's own
  // print is of the Error
  const consoleError = t.mock.method(console, 'error', () => {});
  const printed = () => consoleError.mock.calls.filter(c => c.arguments[0] instanceof Error);
  return { transport, heard, consoleError, printed };
}
// Logs n lines; returns how many callbacks ran. emitWarning delivers on a later tick.
async function logLines(transport, n) {
  let callbacks = 0;
  for (let i = 0; i < n; i++) {
    transport.log({ level: 'info', message: `line ${i}` }, () => callbacks++);
  }
  await new Promise(setImmediate);
  return callbacks;
}

test('a stopped pool: 5 lines give 1 warning, 1 warn, 5 callbacks, no console.error', async t => {
  const { transport, heard, printed } = rig(t);
  await transport.client.stop();
  assert.strictEqual(await logLines(transport, 5), 5);
  assert.strictEqual(heard.warning.length, 1);
  assert.strictEqual(heard.warn.length, 1);
  assert.strictEqual(heard.warn[0].code, 'POOL_STOPPED');
  assert.deepStrictEqual(printed(), []);
});

test('the warn-once flag is per transport: two stopped transports warn once each', async t => {
  const a = rig(t);
  const b = new WinstonAMQPPoolTransport({ pool });
  t.after(() => b.client.stop());
  const bWarn = [];
  b.on('warn', e => bWarn.push(e));
  await Promise.all([a.transport.client.stop(), b.client.stop()]);
  await logLines(a.transport, 2);
  await logLines(b, 2);
  assert.strictEqual(a.heard.warning.length, 2);
  assert.strictEqual(a.heard.warn.length, 1);
  assert.strictEqual(bWarn.length, 1);
});

test('the error is matched by its code, not its text', async t => {
  const { transport, heard, printed } = rig(t);
  transport.client.publish = () => {
    throw Object.assign(new Error('other text'), { code: 'POOL_STOPPED' });
  };
  await logLines(transport, 2);
  assert.strictEqual(heard.warn.length, 1);
  assert.deepStrictEqual(printed(), []);
});

test('another publish error keeps console.error, with no warning', async t => {
  const { transport, heard, consoleError } = rig(t);
  const err = new Error('Pool is stopped');
  transport.client.publish = () => { throw err; };
  assert.strictEqual(await logLines(transport, 2), 2);
  assert.deepStrictEqual(consoleError.mock.calls.map(c => c.arguments[0]), [err, err]);
  assert.strictEqual(heard.warning.length + heard.warn.length, 0);
});

test('lines after close() are dropped with no warning, warn or console.error', async t => {
  const { transport, heard, consoleError } = rig(t);
  const stop = t.mock.method(transport.client, 'stop');
  transport.close();
  assert.strictEqual(stop.mock.callCount(), 1);
  assert.strictEqual(await logLines(transport, 3), 3);
  assert.strictEqual(heard.warning.length + heard.warn.length, 0);
  assert.strictEqual(consoleError.mock.callCount(), 0);
});

test('close() swallows a rejected stop()', async t => {
  const { transport } = rig(t);
  const rejected = [];
  const onRejection = e => rejected.push(e);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  t.mock.method(transport.client, 'stop', () => Promise.reject(new Error('teardown')));
  transport.close();
  await new Promise(setImmediate);
  assert.deepStrictEqual(rejected, []);
});

test('a running pool: log() publishes the line with the strategy and topic', async t => {
  const { transport } = rig(t);
  const publish = t.mock.method(transport.client, 'publish', () => {});
  assert.strictEqual(await logLines(transport, 1), 1);
  const line = JSON.stringify({ level: 'info', message: 'line 0' });
  assert.deepStrictEqual(publish.mock.calls[0].arguments, [line, 'all', 'logs']);
});

test('a line JSON.stringify refuses: log() does not throw, calls back, console.errors it', t => {
  const { transport, consoleError } = rig(t);
  const info = { level: 'info', message: 'loop' };
  info.self = info;
  let callbacks = 0;
  transport.log(info, () => callbacks++);
  assert.strictEqual(callbacks, 1);
  assert.strictEqual(consoleError.mock.callCount(), 1);
});

// Swaps the runner's uncaughtException listeners for a capture, restored after the test
function captureUncaught(t) {
  const got = [];
  const saved = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  const capture = e => got.push(e);
  process.on('uncaughtException', capture);
  t.after(() => {
    process.off('uncaughtException', capture);
    for (const listener of saved) process.on('uncaughtException', listener);
  });
  return got;
}

test('a throwing warn listener: log() does not throw, calls back once, the error surfaces',
  async t => {
    const { transport } = rig(t);
    await transport.client.stop();
    const bug = new Error('listener bug');
    transport.on('warn', () => { throw bug; });
    const uncaught = captureUncaught(t);
    assert.strictEqual(await logLines(transport, 1), 1);
    assert.deepStrictEqual(uncaught, [bug]);
  });
