// #90: a listener that throws on an event the connect chain emits must not reach the connect
// catch, which marks the live connection dead and connects again beside it, one more broker
// connection per retry. The live connection stays the only one.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const Connection = require('../Connection');
const { FakeAmqpChannel } = require('./helpers/fakes');
const { MGMT, mgmt, until, connectionNamed } = require('./helpers/mgmt');

const SAFE_URL = 'amqp://rabbit.example:5672/';
// enough turns for many 1 ms retries, had the throw reached the connect catch
const RETRY_TURNS = 20;

// amqplib.connect resolves fake connections; open() counts those not closed
function fakeBroker(t) {
  const real = amqplib.connect;
  const made = [];
  amqplib.connect = () => {
    const c = new EventEmitter();
    c.createConfirmChannel = () => Promise.resolve(new FakeAmqpChannel());
    c.close = () => { c.closed = true; c.emit('close'); return Promise.resolve(); };
    made.push(c);
    return Promise.resolve(c);
  };
  t.after(() => { amqplib.connect = real; });
  return { made, open: () => made.filter(c => !c.closed).length };
}
function captureWarnings(t) {
  const got = [];
  const fn = w => got.push(w);
  process.on('warning', fn);
  t.after(() => process.off('warning', fn));
  return got;
}
async function turns(n) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 2));
}
const boom = message => () => { throw new Error(message); };

// Starts a Connection with the row's listeners, waits a pinned count of turns
async function run(t, wire) {
  const broker = fakeBroker(t);
  const warnings = captureWarnings(t);
  const conn = new Connection('amqp://u:p@rabbit.example:5672/', { reconnectInterval: 1 });
  const errors = [];
  wire(conn, errors);
  t.after(() => conn.disconnect());
  conn.start();
  await turns(RETRY_TURNS);
  return { conn, errors, warnings, ...broker };
}
const created = fn => function (e) { if (e?.message === 'Connection created') fn(); };

test('#90 a throwing info listener on connect leaves exactly 1 open connection', async t => {
  const r = await run(t, (conn, errors) => {
    conn.on('info', created(boom('info bug')));
    conn.on('error', e => errors.push(e));
  });
  assert.strictEqual(r.open(), 1);
  assert.strictEqual(r.made.length, 1);
  assert.strictEqual(r.conn.alive, true);
  assert.deepStrictEqual(r.errors.map(e => [e.error.message, e.url]), [['info bug', SAFE_URL]]);
});

test('#90 a throwing error listener on the connection report leaves 1 open', async t => {
  const r = await run(t, conn => {
    conn.on('connection', boom('connection bug'));
    conn.on('error', boom('error bug'));
  });
  assert.strictEqual(r.open(), 1);
  assert.strictEqual(r.made.length, 1);
  assert.strictEqual(r.conn.alive, true);
  assert.deepStrictEqual(r.warnings.map(w => w.message), ['error bug']);
});

// a warning by its fields: Node's unhandled 'error' by its code, else its message
const fields = w => (w.code ? [w.code] : [w.message]);
// more of the class: each throw in the connect chain, and the report of it throwing too
const rows = [
  ['info and error listeners both throw', conn => {
    conn.on('info', created(boom('info bug')));
    conn.on('error', boom('error bug'));
  }, [['error bug']]],
  ['info throws with no error listener', conn => {
    conn.on('info', created(boom('info bug')));
  }, [['ERR_UNHANDLED_ERROR']]],
  ['a channel create throws and the error listener throws', conn => {
    conn.addChannel({ create: boom('create bug') });
    conn.on('error', boom('error bug'));
  }, [['error bug']]],
  ['the error listener throws a string', conn => {
    conn.on('connection', boom('connection bug'));
    conn.on('error', () => { throw 'error string'; });
  }, [['error string']]],
  ['the error listener throws a value String() cannot print', conn => {
    conn.on('connection', boom('connection bug'));
    conn.on('error', () => { throw Object.create(null); });
  }, [['a listener threw an unprintable value']]],
  ['control: no listener throws', conn => {
    conn.on('info', () => {});
    conn.on('error', () => {});
  }, []],
];
for (const [name, wire, warned] of rows) {
  test(`#90 row: ${name}: 1 open connection`, async t => {
    const r = await run(t, wire);
    assert.strictEqual(r.open(), 1);
    assert.strictEqual(r.made.length, 1);
    assert.deepStrictEqual(r.warnings.map(fields), warned);
  });
}

// ---- the connect catch: a failed connect retries whatever the 'error' listener does

// amqplib.connect rejects the first `fails` calls, then resolves fake connections
function flakyBroker(t, fails) {
  const broker = fakeBroker(t);
  const resolve = amqplib.connect;
  let calls = 0;
  amqplib.connect = () => (++calls <= fails ? Promise.reject(new Error('refused')) : resolve());
  return { ...broker, calls: () => calls };
}
const catchRows = [
  ['the error listener throws', conn => conn.on('error', boom('error bug')), [['error bug']]],
  ['no error listener', () => {}, [['ERR_UNHANDLED_ERROR']]],
];
for (const [name, wire, warned] of catchRows) {
  test(`#90 failed connect, ${name}: the retry connects`, async t => {
    const broker = flakyBroker(t, 1);
    const warnings = captureWarnings(t);
    const conn = new Connection('amqp://u:p@rabbit.example:5672/', { reconnectInterval: 1 });
    wire(conn);
    t.after(() => conn.disconnect());
    conn.start();
    await turns(RETRY_TURNS);
    assert.strictEqual(broker.calls(), 2);
    assert.strictEqual(broker.open(), 1);
    assert.strictEqual(conn.alive, true);
    assert.deepStrictEqual(warnings.map(fields), warned);
  });
}

// ---- the 'Connecting' info: a throw breaks neither start() nor the retry timer

const connecting = fn => function (e) { if (e?.message === 'Connecting') fn(); };

test('#90 a throwing Connecting listener: start() connects, the throw is reported', async t => {
  const broker = fakeBroker(t);
  const conn = new Connection('amqp://u:p@rabbit.example:5672/', { reconnectInterval: 1 });
  const errors = [];
  conn.on('info', connecting(boom('connecting bug')));
  conn.on('error', e => errors.push(e));
  t.after(() => conn.disconnect());
  conn.start();
  await turns(RETRY_TURNS);
  assert.strictEqual(broker.open(), 1);
  assert.strictEqual(conn.alive, true);
  const got = errors.map(e => [e.error.message, e.url]);
  assert.deepStrictEqual(got, [['connecting bug', SAFE_URL]]);
});

test('#90 a Connecting listener throwing on the retry: the reconnect happens', async t => {
  const broker = fakeBroker(t);
  const conn = new Connection('amqp://u:p@rabbit.example:5672/', { reconnectInterval: 1 });
  let seen = 0;
  conn.on('info', connecting(() => { if (++seen > 1) throw new Error('retry bug'); }));
  conn.on('error', () => {});
  t.after(() => conn.disconnect());
  conn.start();
  await turns(RETRY_TURNS);
  broker.made[0].close();   // the broker closed it; the retry timer starts again
  await turns(RETRY_TURNS);
  assert.strictEqual(broker.made.length, 2);
  assert.strictEqual(broker.open(), 1);
  assert.strictEqual(conn.alive, true);
});

// ---- the connection's 'error' after connect: with no listener, or a throwing one, it warns

const afterRows = [
  ['no error listener', () => {}, [['ERR_UNHANDLED_ERROR']]],
  ['the error listener throws', conn => conn.on('error', boom('error bug')), [['error bug']]],
];
for (const [name, wire, warned] of afterRows) {
  test(`#90 connection error after connect, ${name}: warned, not thrown`, async t => {
    const r = await run(t, wire);
    assert.doesNotThrow(() => r.made[0].emit('error', new Error('socket gone')));
    await turns(1);
    assert.deepStrictEqual(r.warnings.map(fields), warned);
  });
}

// ---- a warning Node prints a tick later reads only strings copied inside the try

// a child: the 'Connecting' and the refused connect each report through a throwing 'error'
// listener, whose Error has a throwing message getter; it prints the warnings as JSON
const CHILD = `
const Connection = require(process.argv[1]);
const got = [];
process.on('warning', w => got.push(w.message));
process.on('exit', () => console.log(JSON.stringify(got)));
const bad = new Error('x');
Object.defineProperty(bad, 'message', { get() { throw new Error('getter'); } });
const conn = new Connection('amqp://127.0.0.1:1/', { reconnectInterval: 1 });
conn.on('info', () => { throw new Error('info bug'); });
conn.on('error', () => { throw bad; });
conn.start();
conn.disconnect();
`;
test('#90 an Error whose message getter throws: warned as unprintable, exit 0', () => {
  const child = spawnSync(process.execPath, ['-e', CHILD, require.resolve('../Connection')],
    { encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(child.status, 0, child.stderr);
  const unprintable = 'a listener threw an unprintable value';
  assert.deepStrictEqual(JSON.parse(child.stdout), [unprintable, unprintable]);
});

// ---- live broker

const URL_ = process.env.FAMQP_TEST_URL;
const skipLive = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;

// the broker's open connections by this name, at each of a pinned count of reads
async function openPerRead(name, reads = 30) {
  const counts = [];
  for (let i = 0; i < reads; i++) {
    const all = await mgmt('GET', 'connections');
    counts.push(all.filter(c => c.client_properties?.connection_name === name).length);
    await new Promise(r => setTimeout(r, 100));
  }
  return counts;
}

// a live Connection whose 'info' listener throws on connect; errors collects its reports
function startLive(t, name) {
  const conn = new Connection(URL_, { reconnectInterval: 20, connection_name: name });
  const errors = [];
  conn.on('info', created(boom('info bug')));
  conn.on('error', e => errors.push(e));
  t.after(() => conn.disconnect());
  conn.start();
  return { conn, errors };
}

test('#90 live: a throwing info listener leaves 1 broker connection by its name',
  { skip: skipLive }, async t => {
  const name = `r2-g-conn-${process.pid}-${Date.now()}`;
  const { conn, errors } = startLive(t, name);
  const full = `${name}_${os.hostname}`;
  await connectionNamed(full);
  await until(() => errors.length >= 1, 'the info throw reported', 100);
  // each retry, had there been one, opens another within 20 ms
  const counts = await openPerRead(full);
  assert.deepStrictEqual([...new Set(counts)], [1], `open per read: ${counts}`);
  assert.strictEqual(conn.alive, true);
});
