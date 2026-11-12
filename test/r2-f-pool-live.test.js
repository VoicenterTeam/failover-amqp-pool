// #79 through the pool on a live broker: messages in flight when the broker closes the
// connection reach the queue after the reconnect (publish() and a channel's sendToQueue()), and
// stop() reports, once, what the broker never confirmed. Needs FAMQP_TEST_URL; the bounce rows
// also FAMQP_TEST_MGMT_URL.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const amqplib = require('amqplib');
const AMQPPool = require('..');
const { MGMT, connectionNamed, closeConnection } = require('./helpers/mgmt');

const URL_ = process.env.FAMQP_TEST_URL;
const skipBounce = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set'
  : false;
const BATCH = 50;   // sends per event-loop turn
const TURNS = 40;   // turns; the close is asked for at the halfway turn
const POLLS = 300;  // reads of the queue depth, 100 ms apart, before the count is taken as is

async function withBroker(fn) {
  const conn = await amqplib.connect(URL_);
  try {
    return await fn(await conn.createChannel());
  } finally {
    await conn.close();
  }
}
// the ids in the queue, once it holds at least `want` messages or POLLS reads have passed
async function queuedIds(queue, want) {
  for (let i = 0; i < POLLS; i++) {
    const { messageCount } = await withBroker(ch => ch.checkQueue(queue));
    if (messageCount >= want) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return withBroker(async ch => {
    const ids = new Set();
    for (let m = await ch.get(queue, { noAck: true }); m; m = await ch.get(queue, { noAck: true }))
      ids.add(m.properties.messageId);
    return ids;
  });
}

// A started pool with one channel on its own exchange and queue; both removed after the test
async function livePool(t, label, queueOptions) {
  const u = new URL(URL_);
  const name = `r2-f-${label}-${process.pid}`;
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), reconnectInterval: 100, connection_name: name },
    channel: { exchange: { name: `${name}.x`, type: 'direct' },
      queue: { name: `${name}.q`, options: queueOptions },
      binding: { enabled: true, pattern: 'k' }, topic: 'k' },
  }]);
  pool.on('error', () => {});
  t.after(async () => {
    await pool.stop({ confirmTimeout: 0 }).catch(() => {});
    await withBroker(async ch => {
      await ch.deleteQueue(`${name}.q`);
      await ch.deleteExchange(`${name}.x`);
    }).catch(() => {});
  });
  await new Promise(resolve => pool.once('ready', resolve));
  pool.start(20);
  return { name, pool, channel: pool.getAllChannels()[0] };
}

// Sends BATCH a turn for TURNS turns, asking the management API to close the pool's connection
// at the halfway turn. send(id) returns false when it threw; those ids are not owed.
async function bounceWhileSending(name, send) {
  const broker = await connectionNamed(`${name}_${os.hostname}`);
  const accepted = [];
  let closing = null;
  for (let turn = 0; turn < TURNS; turn++) {
    if (turn === TURNS / 2) closing = closeConnection(broker);
    for (let i = 0; i < BATCH; i++) {
      const id = `${turn}.${i}`;
      if (send(id)) accepted.push(id);
    }
    await new Promise(setImmediate);
  }
  await closing;
  return accepted;
}

test('live pool: publish() through a broker-side connection close loses nothing',
  { skip: skipBounce, timeout: 60000 }, async t => {
    const { name, pool } = await livePool(t, 'pub');
    const accepted = await bounceWhileSending(name, id => {
      pool.publish({ id }, undefined, undefined, { messageId: id });
      return true;
    });
    const queued = await queuedIds(`${name}.q`, accepted.length);
    const lost = accepted.filter(id => !queued.has(id));
    assert.deepStrictEqual({ lost: lost.length, accepted: accepted.length },
      { lost: 0, accepted: BATCH * TURNS });
  });

test('live pool: sendToQueue() through a broker-side connection close loses nothing',
  { skip: skipBounce, timeout: 60000 }, async t => {
    const { name, channel } = await livePool(t, 'stq');
    const accepted = await bounceWhileSending(name, id => {
      try {
        channel.sendToQueue(`${name}.q`, { id }, { messageId: id });
        return true;
      } catch {
        return false;   // the channel was down: the caller knows this one failed
      }
    });
    const queued = await queuedIds(`${name}.q`, accepted.length);
    const lost = accepted.filter(id => !queued.has(id));
    assert.deepStrictEqual({ lost: lost.length, someSent: accepted.length > BATCH },
      { lost: 0, someSent: true });
  });

test('live pool: stop() with messages in flight reports what the broker refused, once',
  { skip: !URL_ && 'FAMQP_TEST_URL not set', timeout: 60000 }, async t => {
    // a queue that holds nothing and refuses what it cannot hold: every publish is nacked
    const { name, pool } = await livePool(t, 'stop',
      { arguments: { 'x-max-length': 0, 'x-overflow': 'reject-publish' } });
    const reports = [];
    pool.on('unconfirmed', entries => reports.push(entries.map(e => e.props.messageId)));
    const ids = Array.from({ length: BATCH }, (_, i) => `s.${i}`);
    for (const id of ids) pool.publish({ id }, undefined, undefined, { messageId: id });
    await pool.stop({ confirmTimeout: 10000 });
    assert.deepStrictEqual(reports.map(r => r.slice().sort()), [ids.slice().sort()]);
  });
