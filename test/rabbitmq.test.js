// Integration tests against a real RabbitMQ. Skipped unless FAMQP_TEST_URL is set, e.g.
// FAMQP_TEST_URL=amqp://guest:guest@127.0.0.1:5672 npm test
const { test, after } = require('node:test');
const assert = require('node:assert');
const amqplib = require('amqplib');
const AMQPPool = require('..');
const { leftovers } = require('./helpers/leak-guard');
const { own, acquireOwned } = require('./helpers/own');

const URL_ = process.env.FAMQP_TEST_URL;
const skip = URL_ ? false : 'FAMQP_TEST_URL not set';
const STARTED = Date.now();   // names this run declares carry -<pid>-<ms>, ms from here on
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
  // #93: each handle is owned as it is acquired; a row that timed out releases it at once
  const admin = await amqplib.connect(URL_);
  await own(t, () => admin.close().catch(() => {}));
  const adminCh = await admin.createChannel();
  const declare = () => adminCh.assertQueue(queue,
    { durable: true, autoDelete: false, arguments: { 'x-expires': 600000 } });
  await acquireOwned(t, declare, () => adminCh.deleteQueue(queue).catch(() => {}));
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50 },
    channel: { prefetch: 20, queue: { name: queue } }
  }]);
  const errors = [];
  const infos = [];
  pool.on('error', e => errors.push(e));
  pool.on('info', i => infos.push(i));
  await own(t, async () => {
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
async function poolFor(t, channel) {
  const u = new URL(URL_);
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50 },
    channel
  }]);
  const errors = [];
  pool.on('error', e => errors.push(e));
  await own(t, async () => {
    const stopped = pool.stop();
    pool.on('error', () => {});
    await stopped.catch(() => {});
  });
  return { pool, errors };
}

test('issue #5: a create that fails on a locked queue stays dead and retries until the queue is free', { skip }, async t => {
  const queue = `famqp-locked-${process.pid}-${Date.now()}`;
  // The pool's retry declares this name after the admin deleted it, and its autoDelete never
  // fires without a consumer. This release deletes the queue on its own connection, so it runs
  // even when the test fails midway. Owned first, it runs last: after the pool has stopped and
  // the admin, which holds the queue exclusive until then, has closed.
  await own(t, async () => {
    const c = await amqplib.connect(URL_);
    try { await (await c.createChannel()).deleteQueue(queue); } finally { await c.close().catch(() => {}); }
  });
  const admin = await amqplib.connect(URL_);
  await own(t, () => admin.close().catch(() => {}));
  const adminCh = await admin.createChannel();
  // 405 RESOURCE_LOCKED for any other connection
  await adminCh.assertQueue(queue, { exclusive: true });
  const { pool, errors } = await poolFor(t, { prefetch: 1,
    queue: { name: queue, options: { autoDelete: true, arguments: { 'x-expires': 600000 } } } });
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
  const { pool, errors } = await poolFor(t,
    { prefetch: 1, queue: { name: queue, options: { arguments: { 'x-max-length': 'bad' } } } });
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
  await own(t, () => admin.close().catch(() => {}));
  const adminCh = await admin.createChannel();
  await own(t, async () => {
    await adminCh.deleteQueue(queue).catch(() => {});
    await adminCh.deleteExchange(exchange).catch(() => {});
  });
  await adminCh.assertExchange(exchange, 'direct', { durable: false });
  await adminCh.assertQueue(queue, { durable: true, arguments: { 'x-expires': 600000 } });
  const { pool, errors } = await poolFor(t, { prefetch: 1, exchange: { name: exchange },
    queue: { name: queue }, binding: { enabled: true, pattern: 'k' } });
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

// issue #9: credentials with URL syntax characters log in, and no event carries them.
// Needs the management API to create users, e.g. FAMQP_TEST_MGMT_URL=http://guest:guest@127.0.0.1:15672
const MGMT = process.env.FAMQP_TEST_MGMT_URL;
const skipMgmt = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;

async function mgmt(method, path, body) {
  const m = new URL(MGMT);
  const auth = Buffer.from(`${decodeURIComponent(m.username)}:${decodeURIComponent(m.password)}`).toString('base64');
  const res = await fetch(`${m.origin}/api/${path}`, {
    method, headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(`${method} ${path}: ${res.status}`);
  return method === 'GET' ? res.json() : undefined;
}

// a pool for one user that records every event; returns the recorded events and helpers.
// The user's DELETE is owned before its PUT, so a PUT that fails after the broker made the user
// still leaves none.
async function credentialPool(t, username, password, vhost = '/') {
  const user = `users/${encodeURIComponent(username)}`;
  const put = () => mgmt('PUT', user, { password, tags: '' });
  await acquireOwned(t, put, () => mgmt('DELETE', user));
  const grant = `permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(username)}`;
  await mgmt('PUT', grant, { configure: '.*', write: '.*', read: '.*' });
  const u = new URL(URL_);
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username, password, ssl: false, reconnectInterval: 50 },
    channel: { exchange: { name: 'amq.direct' } }
  }]);
  const events = [];
  const emit = pool.emit.bind(pool);
  pool.emit = (name, ...args) => { events.push([name, args]); return emit(name, ...args); };
  pool.on('error', () => {});
  await own(t, async () => {
    const s = pool.stop(); pool.on('error', () => {}); await s.catch(() => {});
  });
  const text = () => events.map(([n, args]) => n + ' ' + args.map(a => {
    try { return JSON.stringify(a) + (a instanceof Error ? a.message + a.stack : '') + String(a?.error?.message) + String(a?.error?.stack); }
    catch { return String(a); }
  }).join(' ')).join('\n');
  const assertNoSecret = () => {
    for (const s of [password, encodeURIComponent(password)]) assert.ok(!text().includes(s), 'an event carries the password');
  };
  return { pool, events, assertNoSecret };
}

// one subtest per password; the parent timeout lets a failing one run out without cancelling the rest
test('issue #9: passwords with URL syntax characters log in and are not emitted', { skip: skipMgmt, timeout: 60000 }, async t => {
  const passwords = ['/Zm9vYmFy', '?q=1#frag', '#hash', 'a@b:c/d?e#f%25g+h i', '12/34', '%zz'];
  for (const [i, password] of passwords.entries()) {
    await t.test(JSON.stringify(password), async t2 => {
      const username = `famqp-i9-${process.pid}-${STARTED}-${i}`;
      const { pool, assertNoSecret } = await credentialPool(t2, username, password);
      let ready = false;
      pool.on('ready', () => { ready = true; });
      await until(() => ready);
      assertNoSecret();
    });
  }
});

// amqplib 0.10 decodes URL credentials with unescape() after url-parse re-encodes them as UTF-8,
// so a non-ASCII password reaches the broker mangled; the login is refused (README documents it)
test('issue #9: a non-ASCII password is refused (amqplib limit) and is not emitted', { skip: skipMgmt }, async t => {
  const password = 'pässwörd';
  const username = `famqp-i9-${process.pid}-${STARTED}-nonascii`;
  const { events, assertNoSecret } = await credentialPool(t, username, password);
  await until(() => events.some(([n, [a]]) => n === 'error' && /ACCESS_REFUSED|PLAIN login refused/i.test(String(a?.error?.message))));
  assertNoSecret();
});

// #60: a permissions PUT that fails (here on a vhost that does not exist) leaves no user
test('#60 a failing permissions PUT in credentialPool leaves no user on the broker',
  { skip: skipMgmt }, async t => {
    const username = `famqp-i60-${process.pid}-${Date.now()}`;
    const user = `users/${encodeURIComponent(username)}`;
    t.after(() => mgmt('DELETE', user));   // only if this row fails before the hooks below run
    const hooks = [];
    const scope = { after: hook => hooks.push(hook) };
    const missing = `famqp-i60-missing-${process.pid}`;
    // the hooks run however the call ends: a PUT that succeeds leaves a pool to stop
    try {
      await assert.rejects(credentialPool(scope, username, 'pw', missing), /^Error: PUT perm/);
    } finally {
      for (const hook of hooks.reverse()) await hook();
    }
    await assert.rejects(mgmt('GET', user), { message: `GET ${user}: 404` });
  });

// issue #9 review: vhost names with URL syntax characters reach the right vhost
test('issue #9: vhosts with URL syntax characters, and the default vhost, connect', { skip: skipMgmt, timeout: 60000 }, async t => {
  const u = new URL(URL_);
  const user = decodeURIComponent(u.username);
  const id = `${process.pid}-${STARTED}`;   // #98: the guard lists a vhost this run left
  const vhosts = ['/', `/famqp-prod-${id}`, `/famqp-a#b?c-${id}`, `/%famqp-pct-${id}`];
  for (const vhost of vhosts) {
    await t.test(JSON.stringify(vhost), async t2 => {
      const name = vhost.slice(1);
      if (name) {
        const path = `vhosts/${encodeURIComponent(name)}`;
        await acquireOwned(t2, () => mgmt('PUT', path, {}), () => mgmt('DELETE', path));
        await mgmt('PUT', `permissions/${encodeURIComponent(name)}/${encodeURIComponent(user)}`, { configure: '.*', write: '.*', read: '.*' });
      }
      const pool = new AMQPPool([{
        connection: { host: u.hostname, port: Number(u.port), username: user, password: decodeURIComponent(u.password), vhost, ssl: false, reconnectInterval: 50 },
        channel: { exchange: { name: 'amq.direct' } }
      }]);
      pool.on('error', () => {});
      await own(t2, async () => {
        const s = pool.stop(); pool.on('error', () => {}); await s.catch(() => {});
      });
      let ready = false;
      pool.on('ready', () => { ready = true; });
      await until(() => ready);
    });
  }
});

// issue #31: the broker closes the pool's own connection, then stop() resolves, raises no
// unhandled rejection, and starts no new connect. Only the connection whose connection_name is
// this pool's unique name is ever deleted; the management API is used for that and nothing else.
const named = async name =>
  (await mgmt('GET', 'connections')).filter(c => c.client_properties?.connection_name === name);

// The API lists it a moment later. A pinned 500 polls: a row that timed out stops polling.
async function closeFromBroker(name) {
  let mine;
  for (let polls = 0; !(mine = (await named(name))[0]); polls++) {
    if (polls === 500) throw new Error(`connection ${name} never listed`);
    await wait(20);
  }
  await mgmt('DELETE', `connections/${encodeURIComponent(mine.name)}`);
}

function namedPool(t) {
  const u = new URL(URL_);
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 300,
      connection_name: `famqp-i31-${process.pid}-${Date.now()}` },
    channel: { exchange: { name: 'amq.direct' } }
  }]);
  pool.on('error', () => {});
  t.after(async () => { pool.on('error', () => {}); await pool.stop().catch(() => {}); });
  return { pool, connection: pool.connections[0] };
}

function watchRejections(t) {
  const rejections = [];
  const on = e => rejections.push(e);
  process.on('unhandledRejection', on);
  t.after(() => process.off('unhandledRejection', on));
  return rejections;
}

// A pinned count of polls, 600 ms, two reconnectIntervals: time for a reconnect to show.
const pollThrough = async () => { for (let polls = 0; polls < 30; polls++) await wait(20); };

test('issue #31: stop() after a broker-side close resolves, rejects nothing, connects nothing',
  { skip: skipMgmt, timeout: 30000 }, async t => {
    const rejections = watchRejections(t);
    const { pool, connection } = namedPool(t);
    const closed = new Promise(resolve => pool.once('close', resolve));
    await until(() => connection.alive);
    await closeFromBroker(connection.connection_name);
    await closed;
    t.mock.method(amqplib, 'connect');  // counts, and still connects
    await pool.stop();
    await pollThrough();
    assert.strictEqual(amqplib.connect.mock.callCount(), 0, 'no connect after stop()');
    assert.deepStrictEqual([connection.alive, connection.amqpConnection, rejections], [false, undefined, []]);
  });

// issue #49: nothing this process declared may outlive the file. Only with the management API.
const runLeftovers = () =>
  leftovers(path => mgmt('GET', path), { pid: process.pid, since: STARTED, accounts: true });

// #65: the guard sees a queue this run leaves on the live broker, and stops seeing it once gone
test('#65 the leak guard reports a queue this run left, and not after it is deleted',
  { skip: skipMgmt }, async t => {
    const queue = `famqp-i65-${process.pid}-${Date.now()}`;
    const admin = await amqplib.connect(URL_);
    await own(t, () => admin.close().catch(() => {}));
    const ch = await admin.createChannel();
    // durable: RabbitMQ 4 refuses a transient queue that is not exclusive
    const declare = () => ch.assertQueue(queue,
      { durable: true, arguments: { 'x-expires': 600000 } });
    const drop = () => mgmt('DELETE', `queues/%2F/${encodeURIComponent(queue)}`);
    await acquireOwned(t, declare, drop);
    assert.deepStrictEqual(await runLeftovers(), [`queues:${queue}`]);
    await ch.deleteQueue(queue);
    assert.deepStrictEqual(await runLeftovers(), []);
  });

after(async () => {
  if (!MGMT || !URL_) return;
  assert.deepStrictEqual(await runLeftovers(), []);
});
