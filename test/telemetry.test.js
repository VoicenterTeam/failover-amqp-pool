// Telemetry through @opentelemetry/api: the instruments and spans of telemetry/catalogue.js,
// recorded only once an SDK is started, and nothing of @pm2/io left. Tests run in file order:
// the first runs before any SDK is set.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const api = require('@opentelemetry/api');
const amqplib = require('amqplib');
const Channel = require('../Channel');
const Connection = require('../Connection');
const AMQPPool = require('..');
const { CATALOGUE, SCOPE } = require('../telemetry/catalogue');
const { startTracing, startMetrics } = require('./helpers/otel');
const { FakeAmqpChannel } = require('./helpers/fakes');
const { offline } = require('./helpers/offline');

const URL_ = 'amqp://user:secret@rabbit.example:5673';
const SERVER = { 'server.address': 'rabbit.example', 'server.port': 5673 };
const RABBIT = { 'messaging.system': 'rabbitmq' };

// A channel on a fake connection, created and ready.
async function readyChannel(config = { exchange: { name: 'events' }, queue: { name: 'q' }, prefetch: 1 }) {
  const amqp = [];
  const connection = {
    alive: true,
    url: URL_,
    amqpConnection: { createConfirmChannel: () => { const c = new FakeAmqpChannel(); amqp.push(c); return Promise.resolve(c); } },
  };
  const channel = new Channel(connection, config);
  const errors = [];
  channel.on('error', e => errors.push(e));
  const ready = new Promise(resolve => channel.once('ready', resolve));
  channel.create();
  await ready;
  return { channel, connection, fake: () => amqp[amqp.length - 1], errors };
}

const values = points => points.map(p => [p.attributes, p.value]);

test('loading the package loads no @pm2/io and adds no process error listener', () => {
  const out = execFileSync(process.execPath, ['-e', `
    const before = ['uncaughtException', 'unhandledRejection'].map(e => process.listenerCount(e));
    require(${JSON.stringify(path.join(__dirname, '..'))});
    const after = ['uncaughtException', 'unhandledRejection'].map(e => process.listenerCount(e));
    const pm2 = Object.keys(require.cache).filter(f => f.includes('@pm2'));
    console.log(JSON.stringify({ before, after, pm2 }));
  `]).toString();
  assert.deepStrictEqual(JSON.parse(out), { before: [0, 0], after: [0, 0], pm2: [] });
});

test('with no SDK a publish goes out on the caller options, and no provider is set', async () => {
  const { channel, fake } = await readyChannel();
  const options = { persistent: true };
  channel.publish({ a: 1 }, 'rk', options);
  assert.strictEqual(fake().published[0].options, options, 'no copy, no trace header');
  assert.strictEqual(options.headers, undefined);
  assert.strictEqual(api.metrics.getMeterProvider().constructor.name, 'NoopMeterProvider');
  assert.strictEqual(api.trace.getTracerProvider().getDelegate().constructor.name, 'NoopTracerProvider');
});

test('an SDK started after load: each publish is counted, on the package meter', async t => {
  const { channel } = await readyChannel();
  const { metrics, points } = startMetrics(t);
  channel.publish({ a: 1 }, 'rk');
  channel.publish({ a: 2 }, 'rk');
  assert.deepStrictEqual(values(await points('messaging.client.sent.messages')), [[{
    ...RABBIT, 'messaging.operation.name': 'publish', 'messaging.operation.type': 'send',
    'messaging.destination.name': 'events', ...SERVER,
  }, 2]]);
  const [metric] = await metrics();
  assert.deepStrictEqual(metric.scope, { name: SCOPE.name, version: require('../package.json').version, schemaUrl: undefined });
});

test("a per-call exchange other than the configured one is _OTHER, not a series per value", async t => {
  const { channel, fake } = await readyChannel();
  const { points } = startMetrics(t);
  channel.publish({ a: 1 }, 'rk', { exchange: 'tenant.42' });
  channel.publish({ a: 2 }, 'rk', { exchange: 'events' });
  assert.deepStrictEqual(fake().published.map(p => p.exchange), ['tenant.42', 'events'], 'the message still goes to its exchange');
  const names = (await points('messaging.client.sent.messages')).map(p => [p.attributes['messaging.destination.name'], p.value]);
  assert.deepStrictEqual(names.sort(), [['_OTHER', 1], ['events', 1]]);
});

test('a failed publish is counted with its error.type: RangeError, channel_dead', async t => {
  const { channel, connection, fake } = await readyChannel();
  const { points } = startMetrics(t);
  fake().publishError = new RangeError('table too big');
  assert.throws(() => channel.publish({ a: 1 }, 'rk'), RangeError);
  channel.alive = false;
  connection.alive = false;
  assert.throws(() => channel.publish({ a: 1 }, 'rk'), /Channel is dead/);
  const byType = (await points('messaging.client.sent.messages')).map(p => [p.attributes['error.type'], p.value]);
  assert.deepStrictEqual(byType.sort(), [['RangeError', 1], ['channel_dead', 1]]);
});

test('deliveries are counted as consumed, acks and nacks as settled', async t => {
  const { channel, fake } = await readyChannel();
  const { points } = startMetrics(t);
  const got = [];
  channel.on('message', m => got.push(m));
  channel.consume();
  fake().deliver('a');
  fake().deliver('b');
  channel.ack(got[0]);
  channel.nack(got[1]);
  const queue = { ...RABBIT, 'messaging.destination.name': 'q', ...SERVER };
  assert.deepStrictEqual(values(await points('messaging.client.consumed.messages')), [[
    { ...queue, 'messaging.operation.name': 'process', 'messaging.operation.type': 'process' }, 2]]);
  const settled = values(await points('amqp_pool.client.settled.messages'));
  assert.deepStrictEqual(settled.sort((a, b) => a[0]['messaging.operation.name'].localeCompare(b[0]['messaging.operation.name'])), [
    [{ ...queue, 'messaging.operation.name': 'ack', 'messaging.operation.type': 'settle' }, 1],
    [{ ...queue, 'messaging.operation.name': 'nack', 'messaging.operation.type': 'settle' }, 1],
  ]);
});

// Connect refused twice, connect, the broker forces a close, reconnect: all on mocked timers.
async function reconnectScenario(t) {
  const { points } = startMetrics(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let open;
  t.mock.method(amqplib, 'connect', () => open
    ? Promise.resolve(open)
    : Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })));
  const connection = new Connection('amqp://user:secret@broker.example:5672', { reconnectInterval: 10 });
  connection.on('error', () => {});
  connection.on('close', () => {});
  const step = async () => { t.mock.timers.tick(10); await new Promise(setImmediate); };
  connection.start();
  await new Promise(setImmediate);
  await step();                    // the retry after the failed connect
  open = new EventEmitter();
  await step();                    // the second retry connects
  open.emit('error', Object.assign(new Error('CONNECTION_FORCED'), { code: 320 }));
  open.emit('close');
  await step();                    // the reconnect after the close
  connection.reconnectOnClose = false;
  return { points, broker: { ...RABBIT, 'server.address': 'broker.example' } };
}

test('connect failures are counted by server and code; no credentials, no default port', async t => {
  const { points, broker } = await reconnectScenario(t);
  const errors = values(await points('amqp_pool.connection.errors')).sort((a, b) => a[1] - b[1]);
  assert.deepStrictEqual(errors, [
    [{ ...broker, 'error.type': '320' }, 1],
    [{ ...broker, 'error.type': 'ECONNREFUSED' }, 2],
  ]);
});

test('reconnects are counted by server: three starts after the first, no credentials or port', async t => {
  const { points, broker } = await reconnectScenario(t);
  assert.deepStrictEqual(values(await points('amqp_pool.connection.reconnects')), [[broker, 3]]);
});

test('a disconnected connection schedules no reconnect and counts none', async t => {
  const { points } = startMetrics(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const open = new EventEmitter();
  open.close = () => open.emit('close');
  t.mock.method(amqplib, 'connect', () => Promise.resolve(open));
  const connection = new Connection('amqp://broker.example:5672', { reconnectInterval: 10 });
  connection.on('close', () => {});
  connection.start();
  await new Promise(setImmediate);
  connection.disconnect();
  t.mock.timers.tick(10);
  assert.strictEqual(amqplib.connect.mock.callCount(), 1);
  assert.deepStrictEqual(await points('amqp_pool.connection.reconnects'), []);
});

test('pool counts: connections and channels by state, and cached messages', async t => {
  offline(t);
  const { points } = startMetrics(t);
  const pool = new AMQPPool([{ connection: { host: 'rabbit.example', port: 5673 }, channels: [{ queue: { name: 'a' } }, { queue: { name: 'b' } }] }]);
  pool.on('error', () => {});
  pool.publish({ a: 1 });
  pool.publish({ a: 2 });
  const server = { ...RABBIT, ...SERVER };
  assert.deepStrictEqual(values(await points('amqp_pool.connection.count')), [
    [{ ...server, 'amqp_pool.state': 'alive' }, 0], [{ ...server, 'amqp_pool.state': 'down' }, 1]]);
  assert.deepStrictEqual(values(await points('amqp_pool.channel.count')), [
    [{ ...server, 'amqp_pool.state': 'alive' }, 0], [{ ...server, 'amqp_pool.state': 'down' }, 2]]);
  assert.deepStrictEqual(values(await points('amqp_pool.message.cached')), [[RABBIT, 2]]);
  await pool.stop();
  // the SDK repeats an async instrument's last value; a read after stop() would give 3
  pool.msgCache.push({});
  assert.deepStrictEqual(values(await points('amqp_pool.message.cached')), [[RABBIT, 2]], 'a stopped pool is read no more');
});

// Reading `channel.alive` on a dead channel of a live connection starts a create; the counts
// read `isAlive` instead. The connection is up and createConfirmChannel counts its calls.
test('collecting pool counts re-creates no dead channel of a live connection', async t => {
  offline(t);
  const { points } = startMetrics(t);
  const pool = new AMQPPool([{ connection: { host: 'rabbit.example', port: 5673 }, channels: [{ queue: { name: 'a' } }, { queue: { name: 'b' } }] }]);
  pool.on('error', () => {});
  let creates = 0;
  const connection = pool.connections[0];
  connection.amqpConnection = { createConfirmChannel: () => { creates++; return new Promise(() => {}); } };
  connection.alive = true;
  const down = { ...RABBIT, ...SERVER, 'amqp_pool.state': 'down' };
  assert.deepStrictEqual(values(await points('amqp_pool.channel.count')).filter(([a]) => a['amqp_pool.state'] === 'down'), [[down, 2]]);
  assert.strictEqual(creates, 0, 'a collection started no create');
  pool.stop().catch(() => {});
});

test('a publish is a PRODUCER span whose context rides in a copy of the headers', async () => {
  const { spans } = startTracing();
  const { channel, fake } = await readyChannel();
  const options = { headers: { keep: 'me' } };
  channel.publish({ a: 1 }, 'rk', options);
  const [span] = await spans();
  assert.strictEqual(span.name, 'publish events');
  assert.strictEqual(span.kind, api.SpanKind.PRODUCER);
  assert.deepStrictEqual(span.attributes, {
    ...RABBIT, 'messaging.operation.name': 'publish', 'messaging.operation.type': 'send',
    'messaging.destination.name': 'events', ...SERVER,
  });
  const sent = fake().published[0].options.headers;
  assert.strictEqual(sent.keep, 'me');
  assert.strictEqual(sent.traceparent, `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
  assert.deepStrictEqual(options.headers, { keep: 'me' }, "the caller's options are not changed");
});

test("a delivery is a CONSUMER span, child of the publisher's, active in its listeners", async () => {
  const { spans } = startTracing();
  const { channel, fake } = await readyChannel();
  channel.publish({ a: 1 }, 'rk');
  let active;
  channel.on('message', () => { active = api.trace.getActiveSpan(); });
  channel.consume();
  fake().deliver('a', fake().published[0].options.headers);
  const [producer, consumer] = await spans();
  assert.strictEqual(consumer.name, 'process q');
  assert.strictEqual(consumer.kind, api.SpanKind.CONSUMER);
  assert.strictEqual(consumer.spanContext().traceId, producer.spanContext().traceId);
  assert.strictEqual(consumer.parentSpanContext.spanId, producer.spanContext().spanId);
  assert.strictEqual(active.spanContext().spanId, consumer.spanContext().spanId);
});

test('a listener that throws: the span is ERROR with error.type and no text; the throw passes on', async () => {
  const { spans } = startTracing();
  const { channel, fake } = await readyChannel();
  channel.on('message', () => { throw new TypeError('secret 42'); });
  channel.consume();
  assert.throws(() => fake().deliver('a'), /secret 42/);
  const [span] = await spans();
  assert.strictEqual(span.status.code, api.SpanStatusCode.ERROR);
  assert.strictEqual(span.status.message, undefined);
  assert.strictEqual(span.attributes['error.type'], 'TypeError');
  assert.strictEqual(span.parentSpanContext, undefined, 'no headers: a root span');
});

test('a queue the channel names for itself is temporary, not a series per name', async t => {
  const { points } = startMetrics(t);
  const { channel, fake } = await readyChannel({ exchange: { name: 'events' }, prefetch: 1 });
  // consume() with no queue name takes the dynamic path, which names the queue per channel
  channel.consume();
  await new Promise(setImmediate);
  channel.queue.name = `${channel._id}:node-1`;
  channel.consume();
  fake().deliver('a');
  const consumed = await points('messaging.client.consumed.messages');
  assert.deepStrictEqual(consumed.map(p => p.attributes['messaging.destination.temporary']), [true]);
  assert.ok(consumed.every(p => !('messaging.destination.name' in p.attributes)));
});

const rowOf = name => CATALOGUE.find(row => row.name === name || row.kind === name);
function check(name, attributes) {
  const declared = rowOf(name)?.attributes;
  assert.ok(declared, `${name} is in the catalogue`);
  for (const [key, value] of Object.entries(attributes)) {
    assert.ok(Object.hasOwn(declared, key), `${name}: ${key} is declared`);
    if (declared[key]) assert.ok(declared[key].includes(value), `${name}: ${key}=${value}`);
  }
}

// One scenario that records most instruments and both span kinds, for the catalogue checks.
async function recordEverything(t) {
  const { metrics } = startMetrics(t);
  const { spans } = startTracing();
  offline(t);
  const pool = new AMQPPool([{ connection: { host: 'rabbit.example', port: 5673 }, channel: {} }]);
  pool.on('error', () => {});
  pool.publish({ a: 1 });
  const { channel, connection, fake } = await readyChannel();
  channel.on('message', m => channel.ack(m));
  channel.consume();
  channel.publish({ a: 1 }, 'rk');
  fake().deliver('a', fake().published[0].options.headers);
  channel.nack(fake().deliver('b'));
  fake().publishError = new RangeError('x');
  assert.throws(() => channel.publish({ a: 1 }, 'rk'));
  channel.alive = false;
  connection.alive = false;
  assert.throws(() => channel.publish({ a: 1 }, 'rk'));
  t.after(() => pool.stop());
  return { metrics, spans };
}

test('every metric recorded is declared in the catalogue, with its unit, and bounded', async t => {
  const { metrics } = await recordEverything(t);
  const recorded = await metrics();
  assert.ok(recorded.length >= 6, 'the scenario records most instruments');
  for (const metric of recorded) {
    assert.strictEqual(metric.descriptor.unit, rowOf(metric.descriptor.name).unit);
    metric.dataPoints.forEach(p => check(metric.descriptor.name, p.attributes));
  }
});

test('every span attribute recorded is declared in the catalogue, and bounded', async t => {
  const { spans } = await recordEverything(t);
  const kinds = { [api.SpanKind.PRODUCER]: 'producerSpan', [api.SpanKind.CONSUMER]: 'consumerSpan' };
  const recorded = await spans();
  assert.ok(recorded.length >= 2, 'a producer and a consumer span');
  for (const span of recorded) check(kinds[span.kind], span.attributes);
});

const LIVE = process.env.FAMQP_TEST_URL;
test('through RabbitMQ: the consumer span is a child of the producer span', { skip: LIVE ? false : 'FAMQP_TEST_URL not set' }, async t => {
  const { spans } = startTracing();
  const u = new URL(LIVE);
  const queue = `famqp-test-otel-${process.pid}-${Date.now()}`;
  const admin = await amqplib.connect(LIVE);
  const adminCh = await admin.createChannel();
  await adminCh.assertQueue(queue, { durable: false });
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), reconnectInterval: 50 },
    channel: { prefetch: 5, exchange: { name: 'amq.direct' }, binding: { enabled: true, pattern: queue }, queue: { name: queue } },
  }]);
  pool.on('error', () => {});
  t.after(async () => {
    await adminCh.deleteQueue(queue).catch(() => {});
    await admin.close().catch(() => {});
    const stopped = pool.stop();
    pool.on('error', () => {});  // stop() drops listeners; channel teardown may still emit
    await stopped.catch(() => {});
  });
  const channel = await new Promise(resolve => pool.once('ready', resolve));
  const got = new Promise(resolve => channel.on('message', m => { channel.ack(m); resolve(m); }));
  channel.consume();
  pool.publish('hello', undefined, queue, {});
  const m = await got;
  assert.strictEqual(m.content.toString(), 'hello');
  const all = await spans();
  const producer = all.find(s => s.kind === api.SpanKind.PRODUCER);
  const consumer = all.find(s => s.kind === api.SpanKind.CONSUMER);
  assert.strictEqual(producer.name, 'publish amq.direct');
  assert.strictEqual(consumer.name, `process ${queue}`);
  assert.strictEqual(consumer.parentSpanContext.spanId, producer.spanContext().spanId);
});
