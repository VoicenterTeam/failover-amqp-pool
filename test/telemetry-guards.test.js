// Telemetry against SDKs that misbehave, as vc-dal's telemetry-guards: a meter, tracer, span,
// context manager or propagator that throws fails no publish and no delivery. Its own file: the
// global tracer provider and context manager are set once per process.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const api = require('@opentelemetry/api');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const Channel = require('../Channel');

const boom = () => { throw new Error('telemetry broke'); };

// One tracer provider for the process; each test hands it the tracer it wants.
let tracer = { startSpan: boom };
api.trace.setGlobalTracerProvider({ getTracer: () => ({ startSpan: (...args) => tracer.startSpan(...args) }) });
const contexts = new AsyncLocalStorageContextManager().enable();
let broken = false;
api.context.setGlobalContextManager({
  active: () => contexts.active(),
  with: (...args) => (broken ? boom() : contexts.with(...args)),
  bind: (...args) => contexts.bind(...args),
  enable: () => contexts,
  disable: () => contexts,
});
let propagatorBroken = false;
api.propagation.setGlobalPropagator({
  inject: () => { if (propagatorBroken) boom(); },
  extract: ctx => (propagatorBroken ? boom() : ctx),
  fields: () => [],
});

class FakeAmqpChannel extends EventEmitter {
  constructor() { super(); this.published = []; this.consumers = []; }
  prefetch() { return Promise.resolve(); }
  checkExchange() { return Promise.resolve(); }
  checkQueue(queue) { return Promise.resolve({ queue }); }
  consume(queue, cb, opts) { this.consumers.push(cb); return Promise.resolve({ consumerTag: opts.consumerTag }); }
  publish(...args) { this.published.push(args); return true; }
  ack() {}
  deliver(body) { const m = { content: Buffer.from(body), fields: { deliveryTag: 1 }, properties: {} }; this.consumers.forEach(cb => cb(m)); }
}

async function readyChannel() {
  let fake;
  const connection = { alive: true, url: 'amqp://rabbit.example', amqpConnection: { createConfirmChannel: () => Promise.resolve(fake = new FakeAmqpChannel()) } };
  const channel = new Channel(connection, { exchange: { name: 'events' }, queue: { name: 'q' }, prefetch: 1 });
  channel.on('error', () => {});
  const ready = new Promise(resolve => channel.once('ready', resolve));
  channel.create();
  await ready;
  return { channel, fake: () => fake };
}

// One publish and one delivery, each reaching amqplib or the listener exactly once.
async function roundTrip() {
  const { channel, fake } = await readyChannel();
  const handled = [];
  channel.on('message', m => { handled.push(m.content.toString()); channel.ack(m); });
  channel.consume();
  channel.publish({ a: 1 }, 'rk');
  fake().deliver('a');
  assert.strictEqual(fake().published.length, 1);
  assert.deepStrictEqual(handled, ['a']);
}

test.afterEach(() => {
  tracer = { startSpan: boom };
  broken = false;
  propagatorBroken = false;
  api.metrics.disable();
});

test('a tracer whose startSpan throws', roundTrip);

test('a span whose methods all throw', async () => {
  tracer = { startSpan: () => ({ isRecording: boom, setAttribute: boom, setStatus: boom, end: boom, spanContext: boom }) };
  await roundTrip();
});

test('a context manager whose with() throws runs the listeners once, bare', async () => {
  tracer = { startSpan: () => api.trace.wrapSpanContext(api.INVALID_SPAN_CONTEXT) };
  broken = true;
  await roundTrip();
});

test('a propagator that throws', async () => {
  tracer = { startSpan: () => api.trace.wrapSpanContext(api.INVALID_SPAN_CONTEXT) };
  propagatorBroken = true;
  await roundTrip();
});

test('a meter provider whose getMeter throws', async () => {
  api.metrics.setGlobalMeterProvider({ getMeter: boom });
  await roundTrip();
});

test('a meter whose instruments throw', async () => {
  let adds = 0;
  const instrument = { add: () => { adds++; boom(); } };
  api.metrics.setGlobalMeterProvider({
    getMeter: () => ({
      createCounter: () => instrument,
      createObservableUpDownCounter: () => ({}),
      addBatchObservableCallback: () => {},
      removeBatchObservableCallback: () => {},
    }),
  });
  await roundTrip();
  assert.ok(adds >= 3, `the throwing add() was reached (${adds} calls)`);
});

test('a meter whose batch callback cannot be added', async () => {
  api.metrics.setGlobalMeterProvider({
    getMeter: () => ({ createCounter: () => ({ add: boom }), createObservableUpDownCounter: () => ({}), addBatchObservableCallback: boom }),
  });
  await roundTrip();
});

test("a context manager that throws after the listeners returned: they ran once, nothing passes on", async () => {
  tracer = { startSpan: () => api.trace.wrapSpanContext(api.INVALID_SPAN_CONTEXT) };
  const real = api.context._getContextManager();
  const original = real.with;
  real.with = (...args) => { original.apply(real, args); boom(); };
  try { await roundTrip(); } finally { real.with = original; }
});
