// #90: a listener that throws on an event the connect chain emits must not reach the connect
// catch, which marks the live connection dead and connects again beside it, one more broker
// connection per retry. The live connection stays the only one.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
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

// a warning by its fields: Node's unhandled 'error' by its code and the payload's error
const fields = w => (w.code ? [w.code, w.context.error.message] : [w.message]);
// more of the class: each throw in the connect chain, and the report of it throwing too
const rows = [
  ['info and error listeners both throw', conn => {
    conn.on('info', created(boom('info bug')));
    conn.on('error', boom('error bug'));
  }, [['error bug']]],
  ['info throws with no error listener', conn => {
    conn.on('info', created(boom('info bug')));
  }, [['ERR_UNHANDLED_ERROR', 'info bug']]],
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
  ['no error listener', () => {}, [['ERR_UNHANDLED_ERROR', 'refused']]],
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

// ---- live broker

const URL_ = process.env.FAMQP_TEST_URL;
const skipLive = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;

test('#90 live: a throwing info listener leaves 1 broker connection by its name',
  { skip: skipLive }, async t => {
  const name = `r2-g-conn-${process.pid}-${Date.now()}`;
  const conn = new Connection(URL_, { reconnectInterval: 20, connection_name: name });
  const errors = [];
  conn.on('info', created(boom('info bug')));
  conn.on('error', e => errors.push(e));
  t.after(() => conn.disconnect());
  conn.start();
  const full = `${name}_${os.hostname}`;
  await connectionNamed(full);
  await until(() => errors.length >= 1, 'the info throw reported', 100);
  // a pinned count of reads: each retry, had there been one, opens another within 20 ms
  const counts = [];
  for (let i = 0; i < 30; i++) {
    const all = await mgmt('GET', 'connections');
    counts.push(all.filter(c => c.client_properties?.connection_name === full).length);
    await new Promise(r => setTimeout(r, 100));
  }
  assert.deepStrictEqual([...new Set(counts)], [1], `open per read: ${counts}`);
  assert.strictEqual(conn.alive, true);
});
