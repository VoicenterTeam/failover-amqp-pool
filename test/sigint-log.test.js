// What SIGINT does to a pool: it stops, logs one 'info' (or 'error' when stop() rejects), and
// never exits; the app owns the exit. Each row runs a child process that is sent a real SIGINT.
// No broker except the last row (FAMQP_TEST_URL, and FAMQP_TEST_MGMT_URL for the broker count).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHILD = `
  const cfg = JSON.parse(process.env.SIGLOG_CFG);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const realExit = process.exit;
  process.exit = (code) => { out({ exitCalled: code }); realExit(code); };
  process.on('unhandledRejection', (e) => out({ unhandled: String(e) }));
  process.on('warning', (w) => out({ warning: w.message }));
  // after SIGINT, the pool's own listener has begun stop(); the rows act here, mid-flight
  let armed = false;
  const turns = (n, fn) => { if (n > 0) setImmediate(() => turns(n - 1, fn)); else fn(); };
  if (!cfg.noArm) {
    process.on('SIGINT', () => {
      armed = true;
      // a microtask: it runs once the pool's own SIGINT listener has begun its stop()
      queueMicrotask(() => {
        if (cfg.appStop) pool.stop().catch(() => {});
        if (cfg.readd) pool.on('info', onInfo);
      });
      if (cfg.final) turns(60, () => {
        out({
          final: true, infoListeners: pool.listenerCount('info'),
          errorListeners: pool.listenerCount('error')
        });
        if (cfg.lateError) pool.emit('error', new Error('late'));
        turns(5, () => out({ finalDone: true }));
      });
    });
  }
  const amqplib = require('amqplib');
  if (cfg.fake) {
    // a broker whose close() takes 10 turns, so a stop() raced against one turn is caught
    const { EventEmitter } = require('events');
    const { FakeAmqpChannel } = require(cfg.root + '/test/helpers/fakes');
    amqplib.connect = () => {
      const c = new EventEmitter();
      c.close = () => new Promise((resolve) => turns(10, () => { c.emit('close'); resolve(); }));
      c.createConfirmChannel = () => Promise.resolve(new FakeAmqpChannel());
      return Promise.resolve(c);
    };
  }
  const Pool = require(cfg.root);
  const base = process.listenerCount('SIGINT');
  const pool = new Pool([{ connection: cfg.connection, channel: { queue: { name: cfg.queue } } }]);
  const settle = () => turns(20, () => {
    out({ settled: true, sigint: process.listenerCount('SIGINT'), base });
  });
  const heard = (o) => {
    if (cfg.noArm ? false : !armed) return;
    out({ ...o, conns: pool.connections.length });
    settle();
  };
  const onInfo = (m) => heard({ info: m });
  if (cfg.throwingListener) pool.on('info', () => { if (armed) throw new Error('listener'); });
  pool.on('info', onInfo);
  if (!cfg.noErrorListener) pool.on('error', (e) => heard({ error: e.message }));
  if (cfg.throwOnDisconnect) {
    require(cfg.root + '/Connection').prototype.disconnect = () => { throw new Error('boom'); };
  }
  if (cfg.hold) setInterval(() => {}, 1000);
  const ready = () => out({ ready: true, base, sigint: process.listenerCount('SIGINT') });
  if (!cfg.live && !cfg.fake) ready();
  else {
    const poll = setInterval(() => {
      if (pool.connections[0].alive) { clearInterval(poll); ready(); }
    }, 10);
  }
`;

// Starts the child, sends it SIGINT once it is ready, and resolves with its lines and its exit.
function run(t, cfg) {
  const child = spawn(process.execPath, ['-e', CHILD], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      SIGLOG_CFG: JSON.stringify({ root: ROOT, queue: 'sigint-log', ...cfg })
    }
  });
  t.after(() => child.kill('SIGKILL'));
  const lines = [];
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
    waiters.splice(0).forEach((w) => w());
  });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const until = async (name, pred) => {
    while (!lines.some(pred)) {
      const bad = lines.find((l) => 'unhandled' in l);
      if (bad) assert.fail(`unhandled rejection before ${name}: ${bad.unhandled}`);
      const ended = await Promise.race([exited, new Promise((r) => waiters.push(r))]);
      if (ended && !lines.some(pred)) {
        assert.fail(`child ended (${JSON.stringify(ended)}) before ${name}`);
      }
    }
  };
  return { child, lines, exited, until, find: (k) => lines.filter((l) => k in l) };
}

const nap = () => new Promise((resolve) => setTimeout(resolve, 20));
const closedPort = { host: '127.0.0.1', port: 1, reconnectInterval: 60000 };

test('SIGINT logs one info, stops the pool, does not exit while the loop is held', async (t) => {
  const r = run(t, { connection: closedPort, hold: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('settled', (l) => l.settled);
  assert.strictEqual(r.find('info').length, 1);
  assert.deepStrictEqual(r.find('exitCalled'), []);
  const settled = r.find('settled')[0];
  assert.strictEqual(settled.sigint, settled.base, 'stop() left the pool listener on SIGINT');
  assert.strictEqual(r.child.exitCode, null, 'the child exited on its own');
});

test('the info message no longer says Exit', async (t) => {
  const r = run(t, { connection: closedPort, hold: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('info', (l) => 'info' in l);
  assert.doesNotMatch(r.find('info')[0].info, /exit/i);
});

test('with nothing else holding the loop the child ends by itself with code 0', async (t) => {
  const r = run(t, { connection: closedPort });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  assert.deepStrictEqual(await r.exited, { code: 0, signal: null });
  assert.strictEqual(r.find('info').length, 1);
  assert.deepStrictEqual(r.find('exitCalled'), []);
});

test('a stop() that rejects emits error once, no info, no rejection, no exit', async (t) => {
  const r = run(t, { connection: closedPort, hold: true, throwOnDisconnect: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('settled', (l) => l.settled);
  assert.deepStrictEqual(r.find('error').map((l) => l.error), ['boom']);
  assert.deepStrictEqual(r.find('info'), []);
  assert.deepStrictEqual(r.find('unhandled'), []);
  assert.deepStrictEqual(r.find('exitCalled'), []);
  assert.strictEqual(r.child.exitCode, null);
});

test('a listener that throws is warned about, and the next listener still hears', async (t) => {
  const r = run(t, { connection: closedPort, throwingListener: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  assert.deepStrictEqual(await r.exited, { code: 0, signal: null });
  assert.deepStrictEqual(r.find('warning'), [{ warning: 'listener' }]);
  assert.strictEqual(r.find('info').length, 1);
  assert.deepStrictEqual(r.find('unhandled'), []);
});

test('the SIGINT info arrives after stop() has closed every connection', async (t) => {
  const r = run(t, { connection: closedPort, fake: true, hold: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('info', (l) => 'info' in l);
  assert.strictEqual(r.find('info')[0].conns, 0);
});

test('an app that stops the pool mid-flight does not hear the SIGINT info', async (t) => {
  const r = run(t, { connection: closedPort, fake: true, hold: true, appStop: true, final: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('final', (l) => l.finalDone);
  assert.deepStrictEqual(r.find('info'), []);
  assert.strictEqual(r.find('final')[0].infoListeners, 0);
});

test('a listener the app re-adds mid-flight hears the SIGINT info once', async (t) => {
  const r = run(t, { connection: closedPort, fake: true, hold: true, readd: true, final: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('final', (l) => l.finalDone);
  assert.strictEqual(r.find('info').length, 1);
});

test('after the SIGINT log the app listeners are gone and a late error is absorbed', async (t) => {
  const r = run(t, {
    connection: closedPort, fake: true, hold: true, final: true, lateError: true
  });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('final', (l) => l.finalDone);
  // stop() leaves its own no-op 'error' listener, which absorbs the late error
  assert.deepStrictEqual(r.find('final')[0], { final: true, infoListeners: 0, errorListeners: 1 });
  assert.deepStrictEqual(r.find('error'), []);
  assert.deepStrictEqual(r.find('unhandled'), []);
});

test('a rejecting stop() with no app error listener is warned about, not lost', async (t) => {
  const r = run(t, {
    connection: closedPort, fake: true, hold: true, throwOnDisconnect: true, noErrorListener: true
  });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('the warning', (l) => 'warning' in l);
  assert.deepStrictEqual(r.find('warning'), [{ warning: 'boom' }]);
  assert.deepStrictEqual(r.find('info'), []);
});

test('a second SIGINT, with no other listener, ends the process by signal', async (t) => {
  const r = run(t, { connection: closedPort, hold: true, noArm: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  const mine = (l) => typeof l.info === 'string' && /SIGINT/.test(l.info);
  await r.until('the SIGINT info', mine);
  assert.strictEqual(r.child.exitCode, null);
  r.child.kill('SIGINT');
  // a signal death is what a shell reports as 130
  assert.deepStrictEqual(await r.exited, { code: null, signal: 'SIGINT' });
});

// A user and its connections are the broker-side handle on this pool alone.
const LIVE = process.env.FAMQP_TEST_URL;
const MGMT = process.env.FAMQP_TEST_MGMT_URL;
test('SIGINT closes the live pool connection on the broker',
  { skip: LIVE ? false : 'FAMQP_TEST_URL not set' }, async (t) => {
    const u = new URL(LIVE);
    let connections = null;
    let user = decodeURIComponent(u.username);
    let pass = decodeURIComponent(u.password);
    if (MGMT) {
      const m = new URL(MGMT);
      const cred = `${decodeURIComponent(m.username)}:${decodeURIComponent(m.password)}`;
      const auth = 'Basic ' + Buffer.from(cred).toString('base64');
      const api = (method, p, body) => fetch(`${m.origin}/api/${p}`, {
        method,
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: body && JSON.stringify(body)
      });
      user = `sigintlog-${process.pid}`;
      pass = 'sigintlog-pass';
      assert.ok((await api('PUT', `users/${user}`, { password: pass, tags: '' })).ok);
      t.after(() => api('DELETE', `users/${user}`));
      const all = { configure: '.*', write: '.*', read: '.*' };
      assert.ok((await api('PUT', `permissions/%2F/${user}`, all)).ok);
      connections = async () => {
        const res = await api('GET', `connections/username/${user}`);
        return (await res.json()).length;
      };
    }
    const r = run(t, {
      hold: true, queue: `sigint-live-${process.pid}`,
      connection: {
        host: u.hostname, port: Number(u.port), ssl: false, username: user, password: pass
      }
    });
    await r.until('ready', (l) => l.ready);
    if (connections) {
      for (let i = 0; i < 500 && (await connections()) !== 1; i++) await nap();
      assert.strictEqual(await connections(), 1, 'the pool never showed on the broker');
    }
    r.child.kill('SIGINT');
    // the pool's own channel and connection events are 'info' too; the SIGINT one is a string
    const mine = (l) => typeof l.info === 'string' && /SIGINT/.test(l.info);
    await r.until('the SIGINT info', mine);
    assert.strictEqual(r.lines.find(mine).conns, 0);
    // every info is followed by a settled line, 20 turns on, so an exit after it is seen
    await r.until('every info settled', () => {
      return r.find('settled').length >= r.find('info').length;
    });
    assert.strictEqual(r.lines.filter(mine).length, 1);
    assert.deepStrictEqual(r.find('exitCalled'), []);
    assert.strictEqual(r.child.exitCode, null);
    if (connections) {
      for (let i = 0; i < 500 && (await connections()) !== 0; i++) await nap();
      assert.strictEqual(await connections(), 0, 'the pool left a connection on the broker');
    }
  });
