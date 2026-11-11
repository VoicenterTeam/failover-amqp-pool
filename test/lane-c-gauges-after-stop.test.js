// #72: a stopped pool unregisters its reader, and the SDK repeats an async instrument's last
// value for a series nobody observes. The pool counts of a server whose pools have all stopped
// must read 0, while pools that remain keep summing, and a server that comes back is counted.
const { test } = require('node:test');
const assert = require('node:assert');
const AMQPPool = require('..');
const { startMetrics } = require('./helpers/otel');
const { offline } = require('./helpers/offline');

const SERVER = {
  'messaging.system': 'rabbitmq', 'server.address': 'rabbit.example', 'server.port': 5673,
};
const CONNECTIONS = 'amqp_pool.connection.count';
const CHANNELS = 'amqp_pool.channel.count';

// A pool whose one connection never dials, with `n` channels: every count is 'down'.
function pool(n, host = 'rabbit.example') {
  const channels = Array.from({ length: n }, (_, i) => ({ queue: { name: `q${i}` } }));
  const created = new AMQPPool([{ connection: { host, port: 5673 }, channels }]);
  created.on('error', () => {});
  return created;
}

// The server's points of one instrument as { alive, down }; a series it lacks is undefined.
async function counts(points, name) {
  const got = {};
  for (const p of await points(name)) {
    const { 'amqp_pool.state': state, ...server } = p.attributes;
    assert.deepStrictEqual(server, SERVER);
    assert.strictEqual(got[state], undefined, `one ${state} point`);
    got[state] = p.value;
  }
  return got;
}

test('after stop() both gauges read 0 for the server', async t => {
  offline(t);
  const { points } = startMetrics(t);
  const one = pool(2);
  assert.deepStrictEqual(await counts(points, CONNECTIONS), { alive: 0, down: 1 });
  assert.deepStrictEqual(await counts(points, CHANNELS), { alive: 0, down: 2 });
  await one.stop();
  assert.deepStrictEqual(await counts(points, CONNECTIONS), { alive: 0, down: 0 });
  assert.deepStrictEqual(await counts(points, CHANNELS), { alive: 0, down: 0 });
});

test('two pools on one server: one stops, the other is still summed', async t => {
  offline(t);
  const { points } = startMetrics(t);
  const [a, b] = [pool(2), pool(3)];
  assert.deepStrictEqual(await counts(points, CHANNELS), { alive: 0, down: 5 });
  await a.stop();
  assert.deepStrictEqual(await counts(points, CONNECTIONS), { alive: 0, down: 1 });
  assert.deepStrictEqual(await counts(points, CHANNELS), { alive: 0, down: 3 });
  await b.stop();
  assert.deepStrictEqual(await counts(points, CHANNELS), { alive: 0, down: 0 });
});

test('a server whose pools stopped is counted again by a new pool', async t => {
  offline(t);
  const { points } = startMetrics(t);
  const first = pool(2);
  assert.deepStrictEqual(await counts(points, CHANNELS), { alive: 0, down: 2 });
  await first.stop();
  assert.deepStrictEqual(await counts(points, CHANNELS), { alive: 0, down: 0 });
  const again = pool(1);
  assert.deepStrictEqual(await counts(points, CONNECTIONS), { alive: 0, down: 1 });
  assert.deepStrictEqual(await counts(points, CHANNELS), { alive: 0, down: 1 });
  await again.stop();
});

test('the cached gauge sums two pools and drops to the one left when one stops', async t => {
  offline(t);
  const { points } = startMetrics(t);
  const [a, b] = [pool(1), pool(1)];
  a.publish({ n: 1 });
  b.publish({ n: 2 });
  b.publish({ n: 3 });
  const cached = async () => (await points('amqp_pool.message.cached')).map(p => p.value);
  assert.deepStrictEqual(await cached(), [3]);
  await a.stop();
  assert.deepStrictEqual(await cached(), [2]);
  await b.stop();
});

test('a new meter provider adds no series for a server stopped under the old one', async t => {
  offline(t);
  await t.test('old provider', async st => {
    const { points } = startMetrics(st);
    const old = pool(1);
    await points(CONNECTIONS);
    await old.stop();
  });
  // a live pool elsewhere, so the new provider's callback runs at all
  const { points } = startMetrics(t);
  const other = pool(1, 'other.example');
  const hosts = async name => (await points(name)).map(p => p.attributes['server.address']);
  assert.deepStrictEqual(await hosts(CONNECTIONS), ['other.example', 'other.example']);
  assert.deepStrictEqual(await hosts(CHANNELS), ['other.example', 'other.example']);
  await other.stop();
});
