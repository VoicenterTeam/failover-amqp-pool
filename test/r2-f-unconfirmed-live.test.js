// #79 on a live broker: the management API closes the connection while a Channel publishes. Each
// message publish() accepted is then in the queue, or was handed back by 'unconfirmed'; none is
// handed back twice, and none the broker confirmed before the close is handed back. Needs
// FAMQP_TEST_URL and FAMQP_TEST_MGMT_URL. The Channel's own close() and a channel error need
// only FAMQP_TEST_URL.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const amqplib = require('amqplib');
const Connection = require('../Connection');
const Channel = require('../Channel');
const { MGMT, until, connectionNamed, closeConnection } = require('./helpers/mgmt');

const URL_ = process.env.FAMQP_TEST_URL;
const skipLive = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;
const BATCH = 100;      // publishes per event-loop turn
const BEFORE = 20;      // turns published before the close is asked for
const MAX_TURNS = 2000; // a bound: the close ends the loop long before

// every message left in the queue, read with basic.get until it is empty
async function drain(queue) {
  const conn = await amqplib.connect(URL_);
  try {
    const ch = await conn.createChannel();
    const ids = [];
    for (let m = await ch.get(queue, { noAck: true }); m; m = await ch.get(queue, { noAck: true }))
      ids.push(m.properties.messageId);
    await ch.deleteQueue(queue);
    return ids;
  } finally {
    await conn.close();
  }
}

// the row's queue and exchange; a Channel re-created after its drain can declare the queue again
async function removeAll(name) {
  const conn = await amqplib.connect(URL_);
  try {
    const ch = await conn.createChannel();
    await ch.deleteQueue(`${name}.q`);
    await ch.deleteExchange(`${name}.x`);
  } finally {
    await conn.close();
  }
}

// A ready Channel on its own Connection, with its exchange and a bound queue; removed after t
async function liveChannel(t, label) {
  const name = `r2-f-${label}-${process.pid}`;
  const conn = new Connection(URL_, { connection_name: name, reconnectInterval: 600000 });
  conn.on('error', () => {});
  const channel = new Channel(conn, { exchange: { name: `${name}.x`, type: 'direct' },
    queue: { name: `${name}.q` }, binding: { enabled: true, pattern: 'k' }, topic: 'k' });
  channel.on('error', () => {});
  conn.addChannel(channel);
  // in this order: the Connection is down before its queue and exchange go
  t.after(async () => {
    await conn.disconnect();
    await removeAll(name).catch(() => {});
  });
  const up = new Promise(resolve => channel.once('ready', resolve));
  conn.start();
  await up;
  return { name, conn, channel };
}

// A Channel publishes BATCH messages per turn; at turn BEFORE it waits for every confirm so far,
// then asks the management API to close its connection and goes on publishing until publish()
// throws. Returns the ids publish() accepted, those confirmed before the close, those queued and
// those handed back.
async function bounceMidPublish(t, label) {
  const { name, conn, channel } = await liveChannel(t, label);
  const broker = await connectionNamed(`${name}_${os.hostname}`);
  const back = [];
  channel.on('unconfirmed', entries => back.push(...entries.map(e => e.props.messageId)));

  const accepted = [];
  let closing = null;
  let confirmed = [];
  for (let turn = 0, open = true; open && turn < MAX_TURNS; turn++) {
    if (turn === BEFORE) {
      await channel.amqpChannel.waitForConfirms();
      confirmed = accepted.slice();
      closing = closeConnection(broker);
    }
    for (let i = 0; open && i < BATCH; i++) {
      const messageId = `${turn}.${i}`;
      try {
        channel.publish({ turn, i }, 'k', { messageId });
        accepted.push(messageId);
      } catch {
        open = false;   // the close reached the client: publish() throws from here on
      }
    }
    await new Promise(setImmediate);
  }
  await closing;
  await until(() => !conn.alive, 'the connection to close');
  const queued = new Set(await drain(`${name}.q`));
  return { accepted, confirmed, queued, back };
}

test('live: a broker-side close mid-publish: each accepted message is queued or handed back',
  { skip: skipLive, timeout: 60000 }, async t => {
    const { accepted, queued, back } = await bounceMidPublish(t, 'lost');
    const handedBack = new Set(back);
    const lost = accepted.filter(id => !queued.has(id) && !handedBack.has(id));
    assert.deepStrictEqual({ lost: lost.length, accepted: accepted.length > BEFORE * BATCH },
      { lost: 0, accepted: true });
    assert.strictEqual(handedBack.size, back.length, 'none handed back twice');
  });

test('live: a message confirmed before the close is not handed back',
  { skip: skipLive, timeout: 60000 }, async t => {
    const { confirmed, back } = await bounceMidPublish(t, 'acked');
    const handedBack = new Set(back);
    assert.strictEqual(confirmed.length, BEFORE * BATCH);
    assert.deepStrictEqual(confirmed.filter(id => handedBack.has(id)), []);
  });

test('live: close() with confirms pending hands nothing back, and the broker has every message',
  { skip: !URL_ && 'FAMQP_TEST_URL not set', timeout: 60000 }, async t => {
    const { name, channel } = await liveChannel(t, 'own');
    const back = [];
    channel.on('unconfirmed', entries => back.push(...entries));
    const ids = Array.from({ length: BEFORE * BATCH }, (_, i) => `own.${i}`);
    for (const messageId of ids) channel.publish({ messageId }, 'k', { messageId });
    await channel.close();
    await new Promise(resolve => process.nextTick(resolve));
    const queued = await drain(`${name}.q`);
    assert.deepStrictEqual({ back: back.length, queued: queued.length },
      { back: 0, queued: ids.length });
  });

test('live: a publish the broker refuses with a channel error comes back with its cause',
  { skip: !URL_ && 'FAMQP_TEST_URL not set', timeout: 60000 }, async t => {
    const { name, channel } = await liveChannel(t, 'cause');
    const back = new Promise(resolve => channel.once('unconfirmed', resolve));
    channel.publish({ n: 1 }, 'k', { messageId: 'refused', exchange: `${name}.missing` });
    const [entry] = await back;
    assert.deepStrictEqual([entry.props.messageId, entry.reason, entry.cause.code],
      ['refused', 'closed', 404]);
    await drain(`${name}.q`);
  });

test('live: waitConfirmed() resolves [] once the broker has confirmed every message',
  { skip: !URL_ && 'FAMQP_TEST_URL not set', timeout: 60000 }, async t => {
    const { name, channel } = await liveChannel(t, 'wait');
    for (let i = 0; i < BEFORE * BATCH; i++) channel.publish({ i }, 'k', { messageId: `w.${i}` });
    const left = await channel.waitConfirmed(30000);
    const queued = await drain(`${name}.q`);
    assert.deepStrictEqual({ left: left.length, queued: queued.length },
      { left: 0, queued: BEFORE * BATCH });
  });
