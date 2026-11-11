// #37: a server whose last channel is gone reads 0 alive and 0 down in amqp_pool.channel.count;
// the SDK would repeat its last value for a server with no observation.
const { test } = require('node:test');
const assert = require('node:assert');
const AMQPPool = require('..');
const { watchPool } = require('../telemetry/metrics');
const { startMetrics } = require('./helpers/otel');
const { offline } = require('./helpers/offline');

const server = {
  'messaging.system': 'rabbitmq', 'server.address': 'rabbit.example', 'server.port': 5673
};
async function channelCount(points) {
  const out = { alive: 0, down: 0 };
  for (const p of await points('amqp_pool.channel.count')) {
    out[p.attributes['amqp_pool.state']] += p.value;
  }
  return out;
}

test('channel.count reads 0 alive and 0 down once the last channel is removed', async t => {
  offline(t);
  const { points } = startMetrics(t);
  const pool = new AMQPPool([{ connection: { host: 'rabbit.example', port: 5673 },
    channels: [{ queue: { name: 'a' } }, { queue: { name: 'b' } }] }]);
  pool.on('error', () => {});
  t.after(() => pool.stop());
  assert.deepStrictEqual(await channelCount(points), { alive: 0, down: 2 });
  for (const channel of pool.getAllChannels()) await pool.removeChannelById(channel._id);
  assert.deepStrictEqual(pool.getAllChannels(), []);
  assert.deepStrictEqual(await channelCount(points), { alive: 0, down: 0 });
});

test('only the server that lost its channels reads 0, the other keeps its count', async t => {
  offline(t);
  const { points } = startMetrics(t);
  const pool = new AMQPPool([
    { connection: { host: 'rabbit.example', port: 5673 }, channel: { queue: { name: 'a' } } },
    { connection: { host: 'other.example', port: 5672 }, channel: { queue: { name: 'b' } } },
  ]);
  pool.on('error', () => {});
  t.after(() => pool.stop());
  await channelCount(points);
  await pool.removeChannelById(pool.connections[0].channels[0]._id);
  const by = {};
  for (const p of await points('amqp_pool.channel.count')) {
    by[`${p.attributes['server.address']} ${p.attributes['amqp_pool.state']}`] = p.value;
  }
  assert.deepStrictEqual(by, {
    'rabbit.example alive': 0, 'rabbit.example down': 0,
    'other.example alive': 0, 'other.example down': 1,
  });
});

test('a reading with a connection and no channels observes 0 alive, 0 down', async t => {
  const { points } = startMetrics(t);
  const url = 'amqp://rabbit.example:5673';
  let channels = [{ url, alive: true }];
  const unwatch = watchPool(() => ({ connections: [{ url, alive: true }], channels, cached: 0 }));
  t.after(unwatch);
  assert.deepStrictEqual(await channelCount(points), { alive: 1, down: 0 });
  channels = [];
  const read = (await points('amqp_pool.channel.count')).map(p => [p.attributes, p.value]);
  assert.deepStrictEqual(read, [
    [{ ...server, 'amqp_pool.state': 'alive' }, 0],
    [{ ...server, 'amqp_pool.state': 'down' }, 0]]);
});
