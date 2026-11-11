// What changed for the pool with amqplib 2: heartbeat=0 now disables heartbeats, and publish
// throws a RangeError for a headers table over 64 KiB. The integration row runs only with
// FAMQP_TEST_URL set, as in rabbitmq.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const amqplib = require('amqplib');
const AMQPPool = require('..');
const { offline } = require('./helpers/offline');

function offlinePool(t, connection = {}) {
  const pool = new AMQPPool([{ connection: { host: '127.0.0.1', port: 5672, ...connection }, channel: {} }]);
  t.after(() => pool.stop());
  const errors = [];
  pool.on('error', e => errors.push(e));
  return { pool, errors };
}

test('heartbeat 0 or unset leaves heartbeat out of the URL; a positive number is passed on', async t => {
  offline(t);
  for (const [heartbeat, query] of [[0, ''], ['0', ''], ['0.5', ''], ['abc', ''], ['', ''], [-5, ''],
    [undefined, ''], [null, ''], [25, '?heartbeat=25'], ['25', '?heartbeat=25']]) {
    const { pool } = offlinePool(t, { heartbeat });
    const url = pool.connections[0].url;
    await pool.stop();   // one pool, so one SIGINT listener, at a time (#44)
    assert.strictEqual(url, `amqp://127.0.0.1:5672${query}`, `heartbeat ${heartbeat}`);
  }
});

test('a RangeError from publish is reported and not cached, under every filter', async t => {
  offline(t);
  for (const filter of [undefined, 'rr', 'all', chs => chs]) {
    const { pool, errors } = offlinePool(t);
    pool.getAliveChannels = () => [{ publish() { throw new RangeError('table too big'); } }];
    pool.publish({ a: 1 }, filter);
    assert.deepStrictEqual(pool.msgCache, [], `filter ${filter}`);
    assert.strictEqual(errors.length, 1, `filter ${filter}`);
    assert.ok(errors[0] instanceof RangeError);
  }
});

test('any other publish failure is still cached for retry', async t => {
  offline(t);
  for (const filter of [undefined, 'rr', 'all', chs => chs]) {
    const { pool } = offlinePool(t);
    pool.getAliveChannels = () => [{ publish() { throw new Error('Channel is dead!'); } }];
    pool.publish({ a: 1 }, filter);
    assert.strictEqual(pool.msgCache.length, 1, `filter ${filter}`);
  }
});

const URL_ = process.env.FAMQP_TEST_URL;
const skip = URL_ ? false : 'FAMQP_TEST_URL not set';

test('an oversized header is refused by publish; the connection stays up', { skip }, async t => {
  const u = new URL(URL_);
  const queue = `famqp-test-big-${process.pid}-${Date.now()}`;
  const admin = await amqplib.connect(URL_);
  const adminCh = await admin.createChannel();
  await adminCh.assertQueue(queue, { durable: true });
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), reconnectInterval: 50 },
    channel: { exchange: { name: 'amq.direct' }, binding: { enabled: true, pattern: queue }, queue: { name: queue } }
  }]);
  const errors = [];
  const closes = [];
  pool.on('error', e => errors.push(e));
  pool.on('close', c => closes.push(c));
  t.after(async () => {
    await adminCh.deleteQueue(queue).catch(() => {});
    await admin.close().catch(() => {});
    const stopped = pool.stop();
    pool.on('error', () => {});
    await stopped.catch(() => {});
  });
  await new Promise(resolve => pool.once('ready', resolve));

  pool.publish('big', undefined, queue, { headers: { big: 'x'.repeat(70 * 1024) } });
  assert.ok(errors.some(e => e instanceof RangeError), 'publish reports the RangeError');
  assert.deepStrictEqual(pool.msgCache, []);

  pool.publish('small', undefined, queue, {});
  const end = Date.now() + 5000;
  let got = false;
  while (!(got = await adminCh.get(queue, { noAck: true })) && Date.now() < end) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.strictEqual(got && got.content.toString(), 'small');
  assert.deepStrictEqual(closes, [], 'no channel or connection closed');
});
