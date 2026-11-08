// Integration tests against a real RabbitMQ. Skipped unless FAMQP_TEST_URL is set, e.g.
// FAMQP_TEST_URL=amqp://guest:guest@127.0.0.1:5672 npm test
const { test } = require('node:test');
const assert = require('node:assert');
const amqplib = require('amqplib');
const AMQPPool = require('..');

const URL_ = process.env.FAMQP_TEST_URL;
const skip = URL_ ? false : 'FAMQP_TEST_URL not set';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(20);
  }
}

async function setup(t) {
  const u = new URL(URL_);
  const queue = `famqp-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const admin = await amqplib.connect(URL_);
  const adminCh = await admin.createChannel();
  await adminCh.assertQueue(queue, { durable: false, autoDelete: false });
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50 },
    channel: { prefetch: 20, queue: { name: queue } }
  }]);
  const errors = [];
  const infos = [];
  pool.on('error', e => errors.push(e));
  pool.on('info', i => infos.push(i));
  t.after(async () => {
    await adminCh.deleteQueue(queue).catch(() => {});
    await admin.close().catch(() => {});
    const stopped = pool.stop();
    pool.on('error', () => {});  // stop() drops listeners; channel teardown may still emit
    await stopped.catch(() => {});
  });
  const send = body => adminCh.sendToQueue(queue, Buffer.from(body), { messageId: body });
  const creates = () => infos.filter(i => i?.message === 'channel created').length;
  return { pool, queue, send, errors, infos, creates };
}

// Broker side channel close: a passive declare of a missing queue makes RabbitMQ close the
// channel with 404. The pool re-creates the channel on its next use, as getAliveChannels does.
async function recreate(ctx, ch) {
  const before = ctx.creates();
  await ch.amqpChannel.checkQueue(`famqp-missing-${Date.now()}`).catch(() => {});
  await until(() => { ch.alive; return ctx.creates() > before; });
}

// Frames on a channel are handled in order: if an ack sent before this made RabbitMQ close the
// channel (406), this round trip rejects. It replaces sleeping before negative assertions.
const barrier = ctx => ctx.pool.getAllChannels()[0].amqpChannel.checkQueue(ctx.queue);

const preconditionFailed = errors => errors.filter(e => e?.code === 406 || /PRECONDITION_FAILED|unknown delivery tag/.test(e?.message || ''));

test('each delivery is handled once after K channel re-creates (consumer listens on ready)', { skip }, async t => {
  const ctx = await setup(t);
  const handled = [];
  let channel;
  ctx.pool.on('ready', ch => {
    channel = ch;
    ch.on('message', m => { handled.push(m.content.toString()); ch.ack(m); });
    ch.consume();
  });
  await until(() => channel && ctx.creates() >= 1);
  for (let k = 0; k < 3; k++) await recreate(ctx, channel);
  ctx.send('after-recreates');
  ctx.send('sentinel');  // queue order: once it is handled, every copy of the first one was too
  await until(() => handled.includes('sentinel'));
  assert.deepStrictEqual(handled, ['after-recreates', 'sentinel']);
  await assert.doesNotReject(barrier(ctx));
  assert.deepStrictEqual(preconditionFailed(ctx.errors), []);
});

test('ack/nack of a message delivered before a re-create is dropped, no PRECONDITION_FAILED', { skip }, async t => {
  for (const op of ['ack', 'nack']) {
    await t.test(op, async t2 => {
      const ctx = await setup(t2);
      let channel;
      const got = [];
      ctx.pool.on('ready', ch => {
        // listener attached once (the VoiceStash guard), consume on every ready as before
        if (!channel) { channel = ch; ch.on('message', m => got.push(m)); }
        ch.consume();
      });
      await until(() => channel && ctx.creates() >= 1);
      // raise the delivery tag on the first channel so the stale tag is unknown on the next
      for (let i = 0; i < 5; i++) ctx.send(`warm-${i}`);
      await until(() => got.length === 5);
      got.splice(0).forEach(m => channel.ack(m));
      ctx.send('held');
      await until(() => got.length === 1);
      const stale = got.shift();
      assert.strictEqual(stale.fields.deliveryTag, 6);

      await recreate(ctx, channel);
      // the broker requeued 'held' when the old channel closed; it comes back redelivered
      await until(() => got.length === 1);
      const redelivered = got.shift();
      assert.strictEqual(redelivered.content.toString(), 'held');
      assert.strictEqual(redelivered.fields.redelivered, true);

      const createsBefore = ctx.creates();
      channel[op](stale);
      await assert.doesNotReject(barrier(ctx), 'the stale ' + op + ' must not close the channel');
      assert.deepStrictEqual(preconditionFailed(ctx.errors), []);
      assert.strictEqual(ctx.creates(), createsBefore, 'no re-create after the stale ' + op);

      // control: the redelivered copy acks normally on the current channel
      channel.ack(redelivered);
      await assert.doesNotReject(barrier(ctx));
      assert.deepStrictEqual(preconditionFailed(ctx.errors), []);
      assert.strictEqual(ctx.creates(), createsBefore);
    });
  }
});

test('control: first ready, consume and ack work', { skip }, async t => {
  const ctx = await setup(t);
  let ready = 0;
  const handled = [];
  ctx.pool.on('ready', ch => {
    ready++;
    ch.on('message', m => { handled.push(m.content.toString()); ch.ack(m); });
    ch.consume();
  });
  await until(() => ready === 1);
  ctx.send('a'); ctx.send('b');
  await until(() => handled.length === 2);
  await assert.doesNotReject(barrier(ctx));
  assert.deepStrictEqual(handled, ['a', 'b']);
  assert.deepStrictEqual(ctx.errors, []);
});

// A pool on its own queue config, for create failures the broker produces.
function poolFor(t, channel) {
  const u = new URL(URL_);
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50 },
    channel
  }]);
  const errors = [];
  pool.on('error', e => errors.push(e));
  t.after(async () => {
    const stopped = pool.stop();
    pool.on('error', () => {});
    await stopped.catch(() => {});
  });
  return { pool, errors };
}

test('issue #5: a create that fails on a locked queue stays dead and retries until the queue is free', { skip }, async t => {
  const queue = `famqp-locked-${process.pid}-${Date.now()}`;
  const admin = await amqplib.connect(URL_);
  t.after(() => admin.close().catch(() => {}));
  const adminCh = await admin.createChannel();
  await adminCh.assertQueue(queue, { exclusive: true });   // 405 RESOURCE_LOCKED for any other connection
  const { pool, errors } = poolFor(t, { prefetch: 1, queue: { name: queue, options: { autoDelete: true } } });
  let ready = 0;
  pool.on('ready', () => ready++);
  await until(() => errors.some(e => e?.message === 'cant establish a channel' && e.err?.code === 405));
  const ch = pool.connections[0].channels[0];
  assert.strictEqual(ch.alive, false, 'dead after the failed create');
  assert.strictEqual(ready, 0);
  await adminCh.deleteQueue(queue);   // the retry now finds no queue, asserts it and succeeds
  await until(() => ready === 1);
  assert.strictEqual(ch.alive, true);
});

test('issue #5: an assertQueue failure after checkQueue 404 fails the create, no ready', { skip }, async t => {
  const queue = `famqp-badargs-${process.pid}-${Date.now()}`;
  const unhandled = [];
  const onUnhandled = r => unhandled.push(r);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  // an invalid x-max-length makes RabbitMQ refuse the declare with 406
  const { pool, errors } = poolFor(t, { prefetch: 1, queue: { name: queue, options: { arguments: { 'x-max-length': 'bad' } } } });
  let ready = 0;
  pool.on('ready', () => ready++);
  await until(() => errors.some(e => e?.message === 'cant establish a channel' && e.err?.code === 406));
  assert.strictEqual(ready, 0);
  assert.strictEqual(pool.connections[0].channels[0].alive, false);
  assert.deepStrictEqual(unhandled, []);
});

test('issue #5: a re-create that fails on a deleted exchange retries and recovers once it is back', { skip }, async t => {
  const id = `${process.pid}-${Date.now()}`;
  const exchange = `famqp-ex-${id}`, queue = `famqp-exq-${id}`;
  const admin = await amqplib.connect(URL_);
  const adminCh = await admin.createChannel();
  t.after(async () => {
    await adminCh.deleteQueue(queue).catch(() => {});
    await adminCh.deleteExchange(exchange).catch(() => {});
    await admin.close().catch(() => {});
  });
  await adminCh.assertExchange(exchange, 'direct', { durable: false });
  await adminCh.assertQueue(queue, { durable: false });
  const { pool, errors } = poolFor(t, { prefetch: 1, exchange: { name: exchange }, queue: { name: queue }, binding: { enabled: true, pattern: 'k' } });
  let ch, recreated = 0;
  pool.on('ready', c => { ch = c; });
  pool.on('recreated', () => recreated++);
  await until(() => ch);
  await adminCh.deleteExchange(exchange);
  await ch.amqpChannel.checkQueue(`famqp-missing-${id}`).catch(() => {});   // broker closes the channel
  await until(() => { ch.alive; return errors.some(e => e?.message === 'cant establish a channel' && e.err?.code === 404); });
  assert.strictEqual(ch.alive, false, 'dead after the failed re-create');
  await adminCh.assertExchange(exchange, 'direct', { durable: false });
  await until(() => recreated === 1);
  const got = [];
  await adminCh.consume(queue, m => m && got.push(m.content.toString()), { noAck: true });  // null when teardown deletes the queue
  ch.publish('after-recovery', 'k');
  await until(() => got.length === 1);
  assert.deepStrictEqual(got, ['after-recovery']);
  assert.strictEqual(recreated, 1);
});

// review round 2: no emitted event carries the credentials from the connection URL
test('connect, publish, close, reconnect and a refused login emit no credentials', { skip }, async t => {
  const u = new URL(URL_);
  const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
  const wrongPass = 'famqp-wrong-s3cret';
  const events = [];
  const record = pool => {
    const emit = pool.emit.bind(pool);
    pool.emit = (name, ...args) => { events.push([name, args]); return emit(name, ...args); };
    pool.on('error', () => {});
  };
  const make = password => new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: user, password, ssl: false, reconnectInterval: 50 },
    channel: { exchange: { name: 'amq.direct' } }
  }]);
  const good = make(pass), bad = make(wrongPass);
  record(good); record(bad);
  t.after(async () => {
    // stop() does not end a never-connected connection's reconnect loop (separate issue), so end it here
    bad.connections.forEach(c => { c.start = () => {}; });
    for (const p of [good, bad]) { const s = p.stop(); p.on('error', () => {}); await s.catch(() => {}); }
  });
  const count = (name, msg) => events.filter(([n, [a]]) => n === name && (!msg || a?.message === msg)).length;
  let ch;
  good.on('ready', c => { ch = c; });
  await until(() => ch);
  ch.publish('one', 'k');
  good.connections[0].amqpConnection.close();   // connection close, then reconnect
  await until(() => count('info', 'Connection created') >= 2 && ch.alive);
  ch.publish('two', 'k');
  await until(() => count('error') >= 1 && events.some(([n, [a]]) => n === 'error' && a?.url?.includes(String(bad.connections[0]?.URL?.host))));
  assert.ok(count('info', 'message published') >= 2);
  assert.ok(count('close') >= 1);
  const text = events.map(([n, args]) => n + ' ' + args.map(a => {
    try { return JSON.stringify(a) + (a instanceof Error ? a.message + a.stack : '') + String(a?.error?.message) + String(a?.error?.stack); }
    catch { return String(a); }
  }).join(' ')).join('\n');
  for (const secret of [`${user}:${pass}@`, `${user}:${wrongPass}@`, wrongPass]) {
    assert.ok(!text.includes(secret), `an event carries ${secret === wrongPass ? 'the wrong password' : 'user:pass@'}`);
  }
});
