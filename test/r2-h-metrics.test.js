// #83 and #85: the cached gauge after the last pool stops, the servers seen kept per meter
// provider, one observation per series and collection, and a pool whose read() throws.
const { test } = require('node:test');
const assert = require('node:assert');
const api = require('@opentelemetry/api');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { MeterProvider, MetricReader } = require('@opentelemetry/sdk-metrics');
const { watchPool } = require('../telemetry/metrics');
const { startMetrics } = require('./helpers/otel');

const CONNECTIONS = 'amqp_pool.connection.count';
const CHANNELS = 'amqp_pool.channel.count';
const CACHED = 'amqp_pool.message.cached';

class Reader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}

// A pool on `host` with one down connection, `n` down channels and `cached` messages.
const reading = (host, n = 1, cached = 0) => () => ({
  connections: [{ url: `amqp://${host}`, alive: false }],
  channels: Array.from({ length: n }, () => ({ url: `amqp://${host}`, alive: false })),
  cached,
});

// A meter provider whose batch callback the test runs by hand: collect() returns each observe
// call of one collection as { name, value, host, state }.
function stubMetrics(t) {
  let callback;
  const meter = {
    createCounter: () => ({ add() {} }),
    createObservableUpDownCounter: name => ({ name }),
    addBatchObservableCallback: cb => { callback = cb; },
    removeBatchObservableCallback: () => {},
  };
  api.metrics.disable();
  api.metrics.setGlobalMeterProvider({ getMeter: () => meter });
  t.after(() => api.metrics.disable());
  return () => {
    const calls = [];
    const observe = ({ name }, value, attributes) => calls.push({
      name, value, host: attributes['server.address'], state: attributes['amqp_pool.state'],
    });
    callback({ observe });
    return calls;
  };
}

const named = (calls, name) => calls.filter(c => c.name === name);
// The { host/state: value } points of one instrument, from the real SDK.
const byServer = points => Object.fromEntries(points.map(p =>
  [`${p.attributes['server.address']}/${p.attributes['amqp_pool.state']}`, p.value]));

test('#83: after the last pool stops the cached gauge reads 0', async t => {
  const { points } = startMetrics(t);
  const unwatch = watchPool(reading('a.example', 1, 5));
  t.after(unwatch);
  assert.deepStrictEqual((await points(CACHED)).map(p => p.value), [5]);
  unwatch();
  assert.deepStrictEqual((await points(CACHED)).map(p => p.value), [0]);
  assert.deepStrictEqual((await points(CACHED)).map(p => p.value), [0], 'a second collection');
});

test('#83: a provider that never saw a pool observes no cached series', t => {
  // second case of the class: the 0 is owed only to a series the provider has reported
  const collect = stubMetrics(t);
  watchPool(reading('a.example', 1, 5))();
  assert.deepStrictEqual(named(collect(), CACHED), []);
});

test('#85 item 1: a provider set again reads 0 for a server that stopped while it was away',
  async t => {
    const providers = ['X', 'Y'].map(() => {
      const reader = new Reader();
      return { provider: new MeterProvider({ readers: [reader] }), reader };
    });
    const [X, Y] = providers;
    const use = ({ provider }) => {
      api.metrics.disable();
      api.metrics.setGlobalMeterProvider(provider);
    };
    const points = async ({ reader }, name) => (await reader.collect()).resourceMetrics
      .scopeMetrics.flatMap(s => s.metrics).filter(m => m.descriptor.name === name)
      .flatMap(m => m.dataPoints);
    try {
      use(X);
      const stopA = watchPool(reading('a.example'));
      t.after(stopA);
      assert.strictEqual(byServer(await points(X, CONNECTIONS))['a.example/down'], 1);
      use(Y);
      const stopB = watchPool(reading('b.example'));
      t.after(stopB);
      stopA();
      await points(Y, CONNECTIONS);
      use(X);
      const stopC = watchPool(reading('c.example'));
      t.after(stopC);
      const got = byServer(await points(X, CONNECTIONS));
      stopB();
      stopC();
      assert.strictEqual(got['a.example/down'], 0);
      assert.strictEqual(got['c.example/down'], 1);
    } finally {
      api.metrics.disable();
    }
  });

test('#85 item 2: after stop() each collection observes each count series once', t => {
  const collect = stubMetrics(t);
  const unwatch = watchPool(reading('a.example', 2));
  t.after(unwatch);
  const counted = calls => calls.filter(c => c.name === CONNECTIONS || c.name === CHANNELS);
  assert.strictEqual(counted(collect()).length, 4, 'running');
  unwatch();
  const perCollection = [1, 2, 3, 4].map(() => counted(collect()).length);
  assert.deepStrictEqual(perCollection, [4, 4, 4, 4]);
});

test('#85 item 3: a pool whose read() throws reads 0, and the other pool is still read', t => {
  const collect = stubMetrics(t);
  let fail = false;
  const good = reading('b.example', 1, 2);
  const flaky = () => {
    if (fail) throw new Error('read failed');
    return reading('a.example', 1, 3)();
  };
  // first in the set, so its throw comes before the good read
  const unwatchFlaky = watchPool(flaky);
  const unwatchGood = watchPool(good);
  t.after(() => { unwatchFlaky(); unwatchGood(); });
  assert.deepStrictEqual(named(collect(), CACHED).map(c => c.value), [5], 'both read');
  fail = true;
  const calls = collect();
  const series = Object.fromEntries(named(calls, CONNECTIONS)
    .map(c => [`${c.host}/${c.state}`, c.value]));
  assert.deepStrictEqual(series,
    { 'a.example/alive': 0, 'a.example/down': 0, 'b.example/alive': 0, 'b.example/down': 1 });
  assert.deepStrictEqual(named(calls, CACHED).map(c => c.value), [2]);
});

// The record is keyed weakly: a provider replaced by another is not held alive by it. gc() needs
// --expose-gc, so the probe runs in a child process; it prints whether the provider was collected.
const GC_PROBE = `
  const api = require('@opentelemetry/api');
  const { MeterProvider, MetricReader } = require('@opentelemetry/sdk-metrics');
  const { watchPool } = require(${JSON.stringify(path.join(__dirname, '../telemetry/metrics'))});
  class Reader extends MetricReader { async onForceFlush() {} async onShutdown() {} }
  const reading = () => ({ connections: [{ url: 'amqp://a.example', alive: true }],
    channels: [], cached: 3 });
  (async () => {
    let ref;
    await (async () => {
      const reader = new Reader();
      const x = new MeterProvider({ readers: [reader] });
      api.metrics.setGlobalMeterProvider(x);
      const stop = watchPool(reading);
      await reader.collect();
      stop();
      ref = new WeakRef(x);
      api.metrics.disable();
    })();
    api.metrics.setGlobalMeterProvider(new MeterProvider({ readers: [new Reader()] }));
    watchPool(reading)();
    for (let i = 0; i < 5; i++) { await new Promise(setImmediate); global.gc(); }
    console.log(JSON.stringify({ collected: ref.deref() === undefined }));
  })();
`;

test('#85 item 1: a provider replaced by another can be garbage-collected', () => {
  const out = execFileSync(process.execPath, ['--expose-gc', '-e', GC_PROBE],
    { cwd: path.join(__dirname, '..'), timeout: 30000 }).toString();
  assert.deepStrictEqual(JSON.parse(out), { collected: true });
});
