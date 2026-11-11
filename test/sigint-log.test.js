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
        // a teardown error: the stopped pool's own channel, after stop() took it off the pool
        if (cfg.lateError) lateChannel.emit('error', new Error('late'));
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
  const lateChannel = pool.connections[0].channels[0];
  const settle = () => turns(20, () => {
    out({ settled: true, sigint: process.listenerCount('SIGINT'), base });
  });
  const heard = (o) => {
    if (cfg.noArm ? false : !armed) return;
    out({ ...o, conns: pool.connections.length });
    settle();
  };
  const onInfo = (m) => heard({ info: m });
  const thrown = {
    object: () => ({ code: 7 }),
    nullProto: () => Object.create(null),
    badToString: () => ({ toString() { throw new Error('toString'); } }),
    proxy: () => new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } }),
    badName: () => Object.defineProperty(new Error('x'), 'name', {
      get() { throw new Error('name getter'); }
    }),
    error: () => new Error('listener')
  };
  if (cfg.throwingListener) pool.on('info', () => {
    if (armed) throw thrown[cfg.throwingListener === true ? 'error' : cfg.throwingListener]();
  });
  pool.on('info', onInfo);
  if (!cfg.noErrorListener) pool.on('error', (e) => {
    heard({ error: e == null ? String(e) : e.message });
  });
  if (cfg.throwOnDisconnect) {
    require(cfg.root + '/Connection').prototype.disconnect = () => {
      throw cfg.rejectWith === 'null' ? null : cfg.rejectWith === 'undefined' ? undefined
        : new Error('boom');
    };
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
  // every wait on the child ends by assertion: a red run never hangs on a line that never comes
  const bounded = async (what, promise) => {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, WAIT, TIMED_OUT); });
    const got = await Promise.race([promise, late]);
    clearTimeout(timer);
    if (got === TIMED_OUT) {
      assert.fail(`no ${what} within ${WAIT} ms; lines ${JSON.stringify(lines)}`);
    }
    return got;
  };
  const until = async (name, pred) => {
    while (!lines.some(pred)) {
      const bad = lines.find((l) => 'unhandled' in l);
      if (bad) assert.fail(`unhandled rejection before ${name}: ${bad.unhandled}`);
      const next = new Promise((r) => waiters.push(r));
      const ended = await bounded(name, Promise.race([exited, next]));
      if (ended && !lines.some(pred)) {
        assert.fail(`child ended (${JSON.stringify(ended)}) before ${name}`);
      }
    }
  };
  const find = (k) => lines.filter((l) => k in l);
  return { child, lines, exited: () => bounded('exit', exited), until, find };
}

const WAIT = 5000;
const TIMED_OUT = Symbol('timed out');
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
  assert.deepStrictEqual(await r.exited(), { code: 0, signal: null });
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
  assert.deepStrictEqual(await r.exited(), { code: 0, signal: null });
  assert.deepStrictEqual(r.find('warning'), [{ warning: 'listener' }]);
  assert.strictEqual(r.find('info').length, 1);
  assert.deepStrictEqual(r.find('unhandled'), []);
});

test('a listener that throws a plain object is warned about, and the log finishes', async (t) => {
  const r = run(t, {
    connection: closedPort, fake: true, hold: true, throwingListener: 'object', final: true
  });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('final', (l) => l.finalDone);
  assert.deepStrictEqual(r.find('unhandled'), []);
  assert.deepStrictEqual(r.find('warning'), [{ warning: '[object Object]' }]);
  assert.strictEqual(r.find('info').length, 1);
  // the app's two info listeners (the throwing one and the logging one) stay after the log
  assert.strictEqual(r.find('final')[0].infoListeners, 2);
});

// warn() must never throw, or the handler rejects and the log is lost. A table: each row is a
// value a listener can throw, with the text the warning carries.
const unprintable = [
  ['an object with no prototype', 'nullProto'],
  ['an object whose toString throws', 'badToString'],
  ['a Proxy whose getPrototypeOf throws', 'proxy'],
  ['an Error whose name getter throws', 'badName']
];
for (const [name, kind] of unprintable) {
  test(`a listener that throws ${name} is warned about with a fixed text`, async (t) => {
    const r = run(t, { connection: closedPort, fake: true, hold: true, throwingListener: kind });
    await r.until('ready', (l) => l.ready);
    r.child.kill('SIGINT');
    await r.until('settled', (l) => l.settled);
    assert.deepStrictEqual(r.find('unhandled'), []);
    assert.deepStrictEqual(r.find('warning'), [{ warning: 'unprintable value' }]);
    assert.strictEqual(r.find('info').length, 1);
  });
}

// A stop() that rejects with null or undefined is still a failure: one 'error', no 'info'.
for (const rejectWith of ['null', 'undefined']) {
  test(`a stop() that rejects with ${rejectWith} emits error once and no info`, async (t) => {
    const r = run(t, { connection: closedPort, hold: true, throwOnDisconnect: true, rejectWith });
    await r.until('ready', (l) => l.ready);
    r.child.kill('SIGINT');
    await r.until('settled', (l) => l.settled);
    assert.deepStrictEqual(r.find('error').map((l) => l.error), [rejectWith]);
    assert.deepStrictEqual(r.find('info'), []);
    assert.deepStrictEqual(r.find('unhandled'), []);
  });
}

test('a stop() that rejects with null and no app error listener is warned about', async (t) => {
  const r = run(t, {
    connection: closedPort, fake: true, hold: true, throwOnDisconnect: true,
    noErrorListener: true, rejectWith: 'null'
  });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('the warning', (l) => 'warning' in l);
  assert.deepStrictEqual(r.find('warning'), [{ warning: 'null' }]);
  assert.deepStrictEqual(r.find('info'), []);
});

test('the SIGINT info arrives after stop() has closed every connection', async (t) => {
  const r = run(t, { connection: closedPort, fake: true, hold: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('info', (l) => 'info' in l);
  assert.strictEqual(r.find('info')[0].conns, 0);
});

// Was 'does not hear': stop() used to clear the app's listeners, so an app stop() mid-flight left
// nobody to hear. The listeners stay now, so the app hears the one log.
test('an app that stops the pool mid-flight still hears the SIGINT info once', async (t) => {
  const r = run(t, { connection: closedPort, fake: true, hold: true, appStop: true, final: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('final', (l) => l.finalDone);
  assert.strictEqual(r.find('info').length, 1);
  assert.strictEqual(r.find('final')[0].infoListeners, 1);
});

// Was 'the app re-adds one': nothing needs re-adding now. The same function added again
// mid-flight is registered twice, and the handler reads the listeners after stop(): twice heard.
test('a listener added again mid-flight hears the SIGINT info twice', async (t) => {
  const r = run(t, { connection: closedPort, fake: true, hold: true, readd: true, final: true });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('final', (l) => l.finalDone);
  assert.strictEqual(r.find('info').length, 2);
});

test('after the SIGINT log the app listeners stay, a late teardown error is silent', async (t) => {
  const r = run(t, {
    connection: closedPort, fake: true, hold: true, final: true, lateError: true
  });
  await r.until('ready', (l) => l.ready);
  r.child.kill('SIGINT');
  await r.until('final', (l) => l.finalDone);
  // a stopped pool emits nothing but the SIGINT log: the late error neither reaches the app's
  // 'error' listener nor throws
  assert.deepStrictEqual(r.find('final')[0], { final: true, infoListeners: 1, errorListeners: 1 });
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
  assert.deepStrictEqual(await r.exited(), { code: null, signal: 'SIGINT' });
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
