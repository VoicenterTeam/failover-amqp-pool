// Queue defaults for RabbitMQ 4.3: a queue the channel names for itself is exclusive and
// transient, a named queue is durable, and x-consumer-timeout is a default for quorum queues only.
// The unit rows read the options the channel sends to assertQueue. The live rows declare from
// nothing and read the queue back from the management API (FAMQP_TEST_URL, FAMQP_TEST_MGMT_URL).
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');
const { MGMT, mgmt, until, queuePath, queueInfo, connectionNamed, closeConnection } =
  require('./helpers/mgmt');
const { own } = require('./helpers/own');

const settle = () => new Promise(resolve => setImmediate(resolve));
const created = ch => new Promise(resolve => {
  const f = i => {
    if (i?.message !== 'channel created' && i?.message !== 'channel create failed') return;
    ch.off('info', f);
    setImmediate(resolve);
  };
  ch.on('info', f);
});

async function ready(config) {
  const amqp = [];
  const connection = {
    alive: true,
    url: 'amqp://user:secret@rabbit.example:5673',
    amqpConnection: {
      createConfirmChannel: () => {
        const c = new FakeAmqpChannel();
        c.strictQueues = true;
        c.binds = 0;
        const bind = c.bindQueue.bind(c);
        c.bindQueue = (...a) => { c.binds++; return bind(...a); };
        amqp.push(c);
        return Promise.resolve(c);
      },
    },
  };
  const channel = new Channel(connection, config);
  const errors = [];
  channel.on('error', e => errors.push(e));
  const up = new Promise(resolve => channel.once('ready', resolve));
  channel.create();
  await up;
  return { channel, errors, amqp, fake: () => amqp[amqp.length - 1] };
}

// the options the channel declares a named queue with
async function declaredNamed(options) {
  const { fake } = await ready({ exchange: { name: 'events' }, queue: { name: 'work', options } });
  return fake().asserted.options;
}
// the options the channel declares the queue it names for itself with
async function declaredDynamic(options) {
  const { channel, fake } = await ready({
    exchange: { name: 'events' }, binding: { enabled: true, pattern: 'rk' }, queue: { options },
  });
  channel.consume();
  await settle();
  return fake().asserted.options;
}

// ---- #53 durable and exclusive

test('#53 a named queue is declared durable and not exclusive by default', async () => {
  const options = await declaredNamed({});
  assert.strictEqual(options.durable, true);
  assert.strictEqual(options.exclusive, false);
});

test('#53 a named queue with no options at all is declared durable', async () => {
  const { fake } = await ready({ exchange: { name: 'events' }, queue: { name: 'work' } });
  assert.strictEqual(fake().asserted.options.durable, true);
});

test('#53 the queue a channel names for itself is exclusive and transient', async () => {
  const options = await declaredDynamic({});
  assert.strictEqual(options.exclusive, true);
  assert.strictEqual(options.durable, false);
});

test('#53 a dynamic queue keeps the 30 minute x-expires default', async () => {
  const options = await declaredDynamic({});
  assert.strictEqual(options.expires, 1800000);
});

test('#53 an explicit durable:false is honoured on a named queue', async () => {
  const options = await declaredNamed({ durable: false });
  assert.strictEqual(options.durable, false);
});

test('#53 an explicit exclusive:true is honoured on a named queue', async () => {
  const options = await declaredNamed({ exclusive: true });
  assert.strictEqual(options.exclusive, true);
});

test('#53 explicit exclusive:false and durable:true are honoured on a dynamic queue', async () => {
  const options = await declaredDynamic({ exclusive: false, durable: true });
  assert.strictEqual(options.exclusive, false);
  assert.strictEqual(options.durable, true);
});

test('#53 an explicit durable:false alone leaves a dynamic queue exclusive', async () => {
  const options = await declaredDynamic({ durable: false });
  assert.strictEqual(options.exclusive, true);
  assert.strictEqual(options.durable, false);
});

test('#53 a channel with no configuration reads the named defaults without throwing', () => {
  const channel = new Channel({ alive: false }, {});
  assert.strictEqual(channel.queueOptions.durable, true);
  assert.strictEqual(channel.queueOptions.exclusive, false);
});

// ---- #53 re-create: the exclusive queue goes with its connection, the new connection declares it

test('#53 a re-create declares the dynamic queue again, exclusive, bound, consumed', async () => {
  // binding.enabled is not set: only the dynamic consume binds, so a re-create must bind too
  const config = { exchange: { name: 'events' }, binding: { pattern: 'rk' }, prefetch: 1 };
  const { channel, amqp, fake } = await ready(config);
  channel.consume();
  await settle();
  const name = channel.queue.name;
  assert.strictEqual(name, `${channel._id}:${os.hostname}`);
  const before = amqp.length;
  const done = created(channel);
  fake().close();    // the connection went, its exclusive queue with it: the check is a 404
  channel.alive;     // the next use re-creates the channel
  await done;
  const now = fake();
  assert.ok(amqp.length > before);
  assert.strictEqual(now.asserted.queue, name);
  assert.strictEqual(now.asserted.options.exclusive, true);
  assert.strictEqual(now.asserted.options.durable, false);
  assert.deepStrictEqual(now.bound, { queue: name, exchange: 'events', pattern: 'rk' });
  assert.strictEqual(now.consumers.length, 1);
});

// ---- the bind on a re-create belongs to the dynamic queue only

const recreateOnce = async (channel, fake) => {
  const done = created(channel);
  fake().close();
  channel.alive;
  await done;
};
const allBinds = amqp => amqp.reduce((n, c) => n + c.binds, 0);

const unbound = [['no binding', undefined], ['binding.enabled false', { enabled: false }]];
for (const [label, binding] of unbound) {
  test(`#53 a named queue with ${label} is not bound on create or re-create`, async () => {
    const { channel, amqp, fake } = await ready({
      exchange: { name: 'events' }, queue: { name: 'work' }, binding, prefetch: 1 });
    await recreateOnce(channel, fake);
    assert.ok(amqp.length > 1, 'the channel was re-created');
    assert.strictEqual(allBinds(amqp), 0);
  });
}

test('#53 a named queue with binding.enabled is bound once per create', async () => {
  const { channel, amqp, fake } = await ready({
    exchange: { name: 'events' }, queue: { name: 'work' }, binding: { enabled: true },
    prefetch: 1 });
  assert.strictEqual(allBinds(amqp), 1);
  await recreateOnce(channel, fake);
  assert.strictEqual(allBinds(amqp), 2);
});

test('#53 a dynamic queue is bound once by its consume, once per re-create', async () => {
  const config = { exchange: { name: 'events' }, binding: { pattern: 'rk' }, prefetch: 1 };
  const { channel, amqp, fake } = await ready(config);
  assert.strictEqual(allBinds(amqp), 0, 'no queue yet, nothing to bind');
  channel.consume();
  await settle();
  assert.strictEqual(allBinds(amqp), 1);
  await recreateOnce(channel, fake);
  assert.strictEqual(allBinds(amqp), 2);
});

// ---- #54 x-consumer-timeout for quorum queues only

test('#54 a classic queue gets no default arguments', async () => {
  const options = await declaredNamed({});
  assert.strictEqual(options.arguments, undefined);
});

test('#54 a quorum queue gets x-consumer-timeout 7200000 next to the caller args', async () => {
  const args = { 'x-queue-type': 'quorum', 'x-max-length': 10 };
  const options = await declaredNamed({ arguments: args });
  assert.deepStrictEqual(options.arguments,
    { 'x-queue-type': 'quorum', 'x-max-length': 10, 'x-consumer-timeout': 7200000 });
});

test('#54 a quorum queue keeps an x-consumer-timeout the caller set', async () => {
  const args = { 'x-queue-type': 'quorum', 'x-consumer-timeout': 60000 };
  const options = await declaredNamed({ arguments: args });
  assert.strictEqual(options.arguments['x-consumer-timeout'], 60000);
});

test('#54 the default goes into a copy: the caller arguments object is not changed', async () => {
  const given = { 'x-queue-type': 'quorum' };
  await declaredNamed({ arguments: given });
  assert.deepStrictEqual(given, { 'x-queue-type': 'quorum' });
});

test('#53 a dynamic quorum or stream queue defaults to durable and not exclusive', async () => {
  for (const type of ['quorum', 'stream']) {
    const options = await declaredDynamic({ arguments: { 'x-queue-type': type } });
    assert.deepStrictEqual([type, options.exclusive, options.durable], [type, false, true]);
  }
});

test('#53 a dynamic stream keeps x-expires and the ttl unless both are none', async () => {
  const stream = { 'x-queue-type': 'stream' };
  const defaults = await declaredDynamic({ arguments: stream });
  assert.deepStrictEqual([defaults.expires, defaults.messageTtl], [1800000, 3600000]);
  const none = await declaredDynamic({ arguments: stream, expires: 'none', messageTtl: 'none' });
  assert.deepStrictEqual([none.expires, none.messageTtl], [undefined, undefined]);
});

test('#53 a dynamic classic queue stays exclusive and transient', async () => {
  const options = await declaredDynamic({ arguments: { 'x-queue-type': 'classic' } });
  assert.deepStrictEqual([options.exclusive, options.durable], [true, false]);
});

test('#53 explicit exclusive and durable win on a dynamic quorum queue', async () => {
  const options = await declaredDynamic({
    exclusive: true, durable: false, arguments: { 'x-queue-type': 'quorum' } });
  assert.deepStrictEqual([options.exclusive, options.durable], [true, false]);
});

test('#53 a named quorum queue is declared durable and not exclusive', async () => {
  const options = await declaredNamed({ arguments: { 'x-queue-type': 'quorum' } });
  assert.deepStrictEqual([options.exclusive, options.durable], [false, true]);
});

test('#54 a dynamic quorum queue gets the default too', async () => {
  const options = await declaredDynamic({ arguments: { 'x-queue-type': 'quorum' } });
  assert.strictEqual(options.arguments['x-consumer-timeout'], 7200000);
});

const passedThrough = [
  ['classic', 'classic'], ['stream', 'stream'],
  ['Quorum', 'Quorum, which is not the broker spelling'], [undefined, 'no x-queue-type'],
];
for (const [type, label] of passedThrough) {
  test(`#54 caller arguments with ${label} are passed through unchanged`, async () => {
    const given = { 'x-max-length': 10, ...(type && { 'x-queue-type': type }) };
    const options = await declaredNamed({ arguments: given });
    assert.deepStrictEqual(options.arguments, given);
  });
}

test('#54 arguments: null declares like no arguments', async () => {
  const options = await declaredNamed({ arguments: null });
  assert.strictEqual(options.arguments, undefined);
});

// ---- live broker: declare from nothing, read back through the management API

const URL_ = process.env.FAMQP_TEST_URL;
const skipLive = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;
let seq = 0;
const unique = what => `famqp-r43-${what}-${process.pid}-${Date.now()}-${seq++}`;

// a pool on the broker with a queue config; the exchange and queues it makes are removed after
async function livePool(t, channelConf, queueNames = []) {
  const amqplib = require('amqplib');
  const AMQPPool = require('..');
  const u = new URL(URL_);
  const exchange = unique('x');
  const connection_name = unique('conn');
  // #93: each handle is owned as it is acquired; a row that timed out releases it at once
  const admin = await amqplib.connect(URL_);
  await own(t, () => admin.close().catch(() => {}));
  const adminCh = await admin.createChannel();
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50,
      connection_name },
    channel: { exchange: { name: exchange, type: 'fanout' }, binding: { enabled: true },
      ...channelConf },
  }]);
  const errors = [];
  const events = [];   // the pool's 'error' and 'info' events in order, for a row that gives up
  pool.on('error', e => { errors.push(e); events.push(['error', e]); });
  pool.on('info', i => events.push(['info', i]));
  await own(t, async () => {
    const stopped = pool.stop();
    pool.on('error', () => {});
    await stopped.catch(() => {});
    for (const q of queueNames) await adminCh.deleteQueue(q).catch(() => {});
    await adminCh.deleteExchange(exchange).catch(() => {});
  });
  const connectionName = `${connection_name}_${os.hostname}`;
  return { pool, admin, adminCh, exchange, errors, events, queueNames, connectionName };
}

// resolves with the first matching event; a run that never gets it fails with the event named
function waitEvent(emitter, event, test = () => true, polls = 90) {
  let got;
  const f = arg => { if (got === undefined && test(arg)) got = arg ?? true; };
  emitter.on(event, f);
  const found = until(() => got, `'${event}'`, polls).finally(() => emitter.off(event, f));
  found.catch(() => {});   // the awaiting line reports it; this one is not an unhandled rejection
  return found;
}
const readyChannel = pool => waitEvent(pool, 'ready');
const recreatedChannel = pool => waitEvent(pool, 'recreated');
const isConsume = i => i?.message?.startsWith?.('consume from queue');
const consuming = ch => waitEvent(ch, 'info', isConsume);

// #78: a wait that, giving up, carries the pool's 'error' and 'info' events in its error's
// `events` field, and names them in its message for the run's log.
async function orEvents(waiting, events) {
  try {
    return await waiting;
  } catch (e) {
    e.events = events.slice();
    const seen = events.map(([name, arg]) => `${name} ${arg?.message ?? arg}`);
    e.message += `; the pool's events: ${seen.join(' | ') || 'none'}`;
    throw e;
  }
}
// 'ready' within `polls` polls of 100 ms
const readyOrEvents = (pool, events, polls) =>
  orEvents(waitEvent(pool, 'ready', undefined, polls), events);

test('#78 a wait for ready that gives up carries the pool events it saw', async () => {
  const events = [['info', { message: 'Connection created' }], ['error', new Error('boom')]];
  const gaveUp = await readyOrEvents(new EventEmitter(), events, 1).catch(e => e);
  assert.deepStrictEqual(gaveUp.events, events);
});

// The quorum rows' window (#78). Declare-to-ready, measured on 3.13.7 and 4.3.7 with
// `node test/helpers/quorum-ready-time.js <amqp url> <runs>`, n=20 alone and n=30 while
// `npm test` ran with both URLs on the same broker: p99 146 / 133 ms alone, 171 / 242 ms loaded.
// A whole row runs longer under the suite (#91): in the PR #84 re-review's n=4 gate runs of
// `npm test` with both URLs, the two quorum rows took 4735 and 3759 ms on 3.13.7 and 3649 and
// 2820 ms on 4.3.7, and 264 to 380 ms in the other runs. So a whole row takes up to 4.7 s.
// The one recorded timeout waited over 9 s, 37 times the worst p99, so latency does not explain
// it, and the window is a floor set above that one failure: 50 times the worst p99, the round
// margin above 37, 12.1 s, 121 polls of 100 ms, 2.6 times the 4.7 s row. A give-up names the
// pool's events (above), which is what tells the next failure's cause.
const QUORUM_READY_POLLS = 121;
// a row with `waits` such waits, plus 10 s for its own steps and cleanup
const quorumRowTimeout = waits => waits * QUORUM_READY_POLLS * 100 + 10000;

test('live: a named queue that does not exist is declared durable, with no consumer timeout',
  { skip: skipLive }, async t => {
  const name = unique('named');
  const { pool } = await livePool(t, { prefetch: 5, queue: { name } }, [name]);
  await readyChannel(pool);
  const info = await queueInfo(name);
  assert.strictEqual(info.durable, true);
  assert.strictEqual(info.exclusive, false);
  assert.strictEqual(info.arguments['x-consumer-timeout'], undefined);
  assert.strictEqual(info.arguments['x-message-ttl'], 3600000);
});

test('live: a dynamic queue that does not exist is declared exclusive, transient, x-expires',
  { skip: skipLive }, async t => {
  const { pool } = await livePool(t, { prefetch: 5 });
  const ch = await readyChannel(pool);
  const done = consuming(ch);
  ch.consume();
  // the dynamic queue's DELETE, registered before the wait: a row that gives up there still
  // removes it, and the #65 guard does not see <id>:<hostname> names. A plain t.after, not
  // own(): own() runs newest first and would delete the queue before livePool stops the pool.
  t.after(() => ch.queue?.name && mgmt('DELETE', queuePath(ch.queue.name)));
  await done;
  const info = await queueInfo(ch.queue.name);
  assert.strictEqual(info.durable, false);
  assert.strictEqual(info.exclusive, true);
  assert.strictEqual(info.arguments['x-expires'], 1800000);
  assert.strictEqual(info.arguments['x-consumer-timeout'], undefined);
});

test('live: a quorum queue that does not exist is declared durable, x-consumer-timeout 7200000',
  { skip: skipLive, timeout: quorumRowTimeout(1) }, async t => {
  const name = unique('quorum');
  const { pool, events } = await livePool(t,
    { prefetch: 5, queue: { name, options: { arguments: { 'x-queue-type': 'quorum' } } } },
    [name]);
  await readyOrEvents(pool, events, QUORUM_READY_POLLS);
  const info = await queueInfo(name);
  assert.strictEqual(info.type, 'quorum');
  assert.strictEqual(info.durable, true);
  assert.strictEqual(info.exclusive, false);
  assert.strictEqual(info.arguments['x-consumer-timeout'], 7200000);
});

test('live: a dynamic quorum queue is declared from nothing, durable, and consumes',
  { skip: skipLive, timeout: quorumRowTimeout(2) }, async t => {
  const conf = { prefetch: 5, queue: { options: { arguments: { 'x-queue-type': 'quorum' } } } };
  const { pool, adminCh, exchange, events } = await livePool(t, conf);
  const ch = await readyOrEvents(pool, events, QUORUM_READY_POLLS);
  const bodies = [];
  ch.on('message', m => { bodies.push(m.content.toString()); ch.ack(m); });
  const done = orEvents(waitEvent(ch, 'info', isConsume, QUORUM_READY_POLLS), events);
  ch.consume();
  t.after(() => ch.queue?.name && mgmt('DELETE', queuePath(ch.queue.name)));   // as above
  await done;
  for (let i = 0; i < 40 && !bodies.includes('hello'); i++) {
    adminCh.publish(exchange, '', Buffer.from('hello'));
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(bodies.includes('hello'), 'the dynamic quorum queue delivered');
  const info = await queueInfo(ch.queue.name);
  assert.strictEqual(info.type, 'quorum');
  assert.strictEqual(info.durable, true);
  assert.strictEqual(info.exclusive, false);
  assert.strictEqual(info.arguments['x-expires'], 1800000);
  assert.strictEqual(info.arguments['x-consumer-timeout'], 7200000);
});

test('live: a dynamic stream with expires and messageTtl none is declared durable, not exclusive',
  { skip: skipLive }, async t => {
  const args = { 'x-queue-type': 'stream', 'x-max-age': '1D' };
  const options = { expires: 'none', messageTtl: 'none', arguments: args };
  const conf = { prefetch: 5, queue: { options } };
  const { pool } = await livePool(t, conf);
  const ch = await readyChannel(pool);
  const done = consuming(ch);
  ch.consume();
  t.after(() => ch.queue?.name && mgmt('DELETE', queuePath(ch.queue.name)));   // as above
  await done;
  const info = await queueInfo(ch.queue.name);
  assert.strictEqual(info.type, 'stream');
  assert.strictEqual(info.durable, true);
  assert.strictEqual(info.exclusive, false);
  assert.strictEqual(info.arguments['x-expires'], undefined);
  assert.strictEqual(info.arguments['x-message-ttl'], undefined);
  assert.strictEqual(info.arguments['x-max-age'], '1D');
});

test('live: after a reconnect the dynamic queue is declared again, its old messages gone',
  { skip: skipLive }, async t => {
  const { pool, adminCh, exchange, connectionName } = await livePool(t, { prefetch: 1 });
  const ch = await readyChannel(pool);
  const bodies = [];
  let held = false;
  ch.on('message', m => {
    const body = m.content.toString();
    bodies.push(body);
    // held-1 is never acked: in flight when the connection goes
    if (body === 'held-1' && !m.fields.redelivered) held = true;
    else ch.ack(m);
  });
  const done = consuming(ch);
  ch.consume();
  t.after(() => ch.queue?.name && mgmt('DELETE', queuePath(ch.queue.name)));   // as above
  await done;
  const name = ch.queue.name;
  adminCh.publish(exchange, '', Buffer.from('held-1'));
  adminCh.publish(exchange, '', Buffer.from('held-2'));    // waits behind held-1 (prefetch 1)
  await until(() => held, 'held-1 delivered', 90);
  const recreated = recreatedChannel(pool);
  await closeConnection(await connectionNamed(connectionName));
  await recreated;
  // the queue is back under the same name, exclusive again; a message published now arrives
  for (let i = 0; i < 40 && !bodies.includes('after'); i++) {
    adminCh.publish(exchange, '', Buffer.from('after'));
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(bodies.includes('after'), 'the re-created queue delivered');
  // held-1 was unacked and held-2 was ready: the queue went with the connection, neither came back
  assert.deepStrictEqual(bodies.filter(b => b.startsWith('held')), ['held-1']);
  assert.strictEqual(ch.queue.name, name);
  const info = await queueInfo(name);
  assert.strictEqual(info.exclusive, true);
  assert.strictEqual(info.durable, false);
});

test('live: a channel re-create on the same connection finds its exclusive queue and consumes',
  { skip: skipLive }, async t => {
  const { pool, adminCh, exchange, errors } = await livePool(t, { prefetch: 1 });
  const ch = await readyChannel(pool);
  const bodies = [];
  ch.on('message', m => { bodies.push(m.content.toString()); ch.ack(m); });
  const done = consuming(ch);
  ch.consume();
  t.after(() => ch.queue?.name && mgmt('DELETE', queuePath(ch.queue.name)));   // as above
  await done;
  const name = ch.queue.name;
  let again = false;
  pool.once('recreated', () => { again = true; });
  // a 404 closes the channel; reading alive re-creates it
  await ch.amqpChannel.checkQueue(`famqp-r43-missing-${process.pid}`).catch(() => {});
  await until(() => { ch.alive; return again; }, 'the channel to be re-created', 40);
  for (let i = 0; i < 40 && !bodies.includes('after'); i++) {
    adminCh.publish(exchange, '', Buffer.from('after'));
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(bodies.includes('after'), 'the re-created channel consumed');
  assert.strictEqual(ch.queue.name, name);
  assert.strictEqual((await queueInfo(name)).exclusive, true);
  // the 404 above is the only error: no RESOURCE_LOCKED, no failed create
  const codes = errors.map(e => e?.message?.match?.(/\b(\d{3}) \(/)?.[1] ?? e?.message);
  assert.deepStrictEqual(codes, ['404']);
});

test('live: a transient named queue is not redeclared; one the pool re-creates comes back durable',
  { skip: skipLive }, async t => {
  const name = unique('transient');
  // declared before the pool starts. A broker that refuses a transient queue that is not
  // exclusive (4.3) closes the connection, and the row has nothing to check there.
  const conn = await require('amqplib').connect(URL_);
  conn.on('error', () => {});
  const made = await conn.createChannel()
    .then(c => { c.on('error', () => {}); return c.assertQueue(name, { durable: false }); })
    .then(() => true, () => false);
  await conn.close().catch(() => {});
  if (!made) return t.skip('this broker refuses a transient queue that is not exclusive');
  const conf = { prefetch: 5, queue: { name } };
  const { pool, adminCh, errors, connectionName } = await livePool(t, conf, [name]);
  await readyChannel(pool);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual((await queueInfo(name)).durable, false);
  await adminCh.deleteQueue(name);
  const recreated = recreatedChannel(pool);
  await closeConnection(await connectionNamed(connectionName));
  await recreated;
  const back = await until(async () => {
    const info = await mgmt('GET', queuePath(name));
    return info?.durable === true && info;
  }, `queue ${name} declared durable`, 40);
  assert.strictEqual(back.durable, true);
});
