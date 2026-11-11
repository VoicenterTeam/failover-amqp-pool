// #79 on a live broker: the management API closes the connection while a Channel publishes. Each
// message publish() accepted is then in the queue, or was handed back by 'unconfirmed'; none is
// handed back twice. Needs FAMQP_TEST_URL and FAMQP_TEST_MGMT_URL.
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

async function removeExchange(exchange) {
  const conn = await amqplib.connect(URL_);
  try {
    const ch = await conn.createChannel();
    await ch.deleteExchange(exchange);
  } finally {
    await conn.close();
  }
}

test('live: a broker-side close mid-publish: each accepted message is queued or handed back',
  { skip: skipLive, timeout: 60000 }, async t => {
    const name = `r2-f-unconfirmed-${process.pid}`;
    const conn = new Connection(URL_, { connection_name: name, reconnectInterval: 600000 });
    conn.on('error', () => {});
    const channel = new Channel(conn, { exchange: { name: `${name}.x`, type: 'direct' },
      queue: { name: `${name}.q` }, binding: { enabled: true, pattern: 'k' }, topic: 'k' });
    channel.on('error', () => {});
    conn.addChannel(channel);
    t.after(() => removeExchange(`${name}.x`).catch(() => {}));
    t.after(() => conn.disconnect());
    const up = new Promise(resolve => channel.once('ready', resolve));
    conn.start();
    await up;
    const broker = await connectionNamed(`${name}_${os.hostname}`);
    const handed = [];
    channel.on('unconfirmed', entries => handed.push(...entries));

    const accepted = [];
    let closing = null;
    for (let turn = 0, open = true; open && turn < MAX_TURNS; turn++) {
      if (turn === BEFORE) closing = closeConnection(broker);
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
    const back = handed.map(e => e.props.messageId);
    const handedBack = new Set(back);
    const lost = accepted.filter(id => !queued.has(id) && !handedBack.has(id));
    assert.deepStrictEqual({ lost: lost.length, accepted: accepted.length > BEFORE * BATCH },
      { lost: 0, accepted: true });
    assert.strictEqual(handedBack.size, back.length, 'none handed back twice');
  });
