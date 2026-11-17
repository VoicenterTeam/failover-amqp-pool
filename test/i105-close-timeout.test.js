'use strict';
// #105: stop() waits up to closeTimeout ms for each connection's close. Unit rows use a fake
// amqplib connection whose close() the test controls; no broker. A stop() that never settles
// leaves nothing on the event loop, so node cancels that row (exit 1); the 3 s bound covers the
// rest.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const AMQPPool = require('..');

const MAX_WAIT = 2147483647;

// A fake amqplib connection on a pool connection marked alive. close: 'hang' never settles,
// 'ok' resolves and emits the connection's 'close' (as amqplib's close does), 'refuse' rejects.
function attach(pool, url, close) {
  const connection = pool.connections[pool.createConnection(url, {})];
  const amqp = new EventEmitter();
  amqp.stream = { destroyed: false, destroy() { this.destroyed = true; } };
  amqp.connection = { stream: amqp.stream };
  amqp.closeCalls = 0;
  amqp.close = () => {
    amqp.closeCalls++;
    if (close === 'hang') return new Promise(() => {});
    if (close === 'refuse') return Promise.reject(new Error('Connection closed'));
    setImmediate(() => connection.emit('close', { msg: 'connection closed', url }));
    return Promise.resolve();
  };
  amqp.on('error', () => {});
  connection.amqpConnection = amqp;
  connection.alive = true;
  return amqp;
}

function setup() {
  const pool = new AMQPPool();
  const infos = [];
  pool.on('info', i => infos.push(i));
  const warnings = [];
  const onWarning = w => warnings.push(w);
  process.on('warning', onWarning);
  const done = () => process.off('warning', onWarning);
  return { pool, infos, warnings, done };
}

const timedOut = infos => infos.filter(i => i?.message === 'connection close timed out');
const later = ms => new Promise(r => setTimeout(r, ms));

test('#105 a close that never settles: stop() resolves after closeTimeout, socket destroyed',
  { timeout: 3000 }, async t => {
    const { pool, infos, warnings, done } = setup();
    t.after(done);
    const amqp = attach(pool, 'amqp://hang.example:5672', 'hang');
    const t0 = Date.now();
    const result = await pool.stop({ confirmTimeout: 0, closeTimeout: 50 });
    const took = Date.now() - t0;
    assert.deepStrictEqual(result, [0]);
    assert.ok(took >= 45 && took < 2000, `took ${took} ms`);
    assert.strictEqual(amqp.closeCalls, 1);
    assert.strictEqual(amqp.stream.destroyed, true);
    assert.strictEqual(pool.connections.length, 0);
    assert.deepStrictEqual(timedOut(infos),
      [{ message: 'connection close timed out', url: 'amqp://hang.example:5672',
        closeTimeout: 50 }]);
    // amqplib's listeners are gone; one no-op 'error' listener keeps a late socket error quiet
    assert.strictEqual(amqp.listenerCount('error'), 1);
    assert.doesNotThrow(() => amqp.emit('error', new Error('read ECONNRESET')));
    await later(20);
    assert.deepStrictEqual(warnings, []);
  });

test('#105 closeTimeout 0 still closes: a hung close is abandoned on the next timer turn',
  { timeout: 3000 }, async t => {
    const { pool, infos, done } = setup();
    t.after(done);
    const amqp = attach(pool, 'amqp://hang.example:5672', 'hang');
    assert.deepStrictEqual(await pool.stop({ confirmTimeout: 0, closeTimeout: 0 }), [0]);
    assert.strictEqual(amqp.stream.destroyed, true);
    assert.strictEqual(timedOut(infos).length, 1);
  });

test('#105 a close that succeeds: no destroy, no info, even after closeTimeout passes',
  async t => {
    const { pool, infos, warnings, done } = setup();
    t.after(done);
    const amqp = attach(pool, 'amqp://ok.example:5672', 'ok');
    const t0 = Date.now();
    assert.deepStrictEqual(await pool.stop({ confirmTimeout: 0, closeTimeout: 300 }), [0]);
    assert.ok(Date.now() - t0 < 250, 'resolved before the timer');
    await later(350);           // the timer was cleared: nothing fires once it would have
    assert.strictEqual(amqp.stream.destroyed, false);
    assert.deepStrictEqual(timedOut(infos), []);
    assert.deepStrictEqual(warnings, []);
  });

test('#105 a refused close resolves as before: no destroy, no info', async t => {
  const { pool, infos, done } = setup();
  t.after(done);
  const amqp = attach(pool, 'amqp://refuse.example:5672', 'refuse');
  assert.deepStrictEqual(await pool.stop({ confirmTimeout: 0, closeTimeout: 300 }), [0]);
  await later(350);
  assert.strictEqual(amqp.stream.destroyed, false);
  assert.deepStrictEqual(timedOut(infos), []);
});

test('#105 one hung and one good connection: both removed, info for the hung one only',
  { timeout: 3000 }, async t => {
    const { pool, infos, done } = setup();
    t.after(done);
    const hung = attach(pool, 'amqp://hang.example:5672', 'hang');
    const good = attach(pool, 'amqp://ok.example:5672', 'ok');
    assert.deepStrictEqual(await pool.stop({ confirmTimeout: 0, closeTimeout: 50 }), [0, 1]);
    assert.strictEqual(pool.connections.length, 0);
    assert.strictEqual(hung.stream.destroyed, true);
    assert.strictEqual(good.stream.destroyed, false);
    assert.deepStrictEqual(timedOut(infos).map(i => i.url), ['amqp://hang.example:5672']);
  });

test('#105 a hung close without an amqplib socket still resolves, without throwing',
  { timeout: 3000 }, async t => {
    const { pool, infos, done } = setup();
    t.after(done);
    const amqp = attach(pool, 'amqp://hang.example:5672', 'hang');
    delete amqp.connection;     // another amqplib shape: nothing to destroy
    assert.deepStrictEqual(await pool.stop({ confirmTimeout: 0, closeTimeout: 20 }), [0]);
    assert.strictEqual(timedOut(infos).length, 1);
  });

test('#105 the default closeTimeout is 5000 ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pool, infos, done } = setup();
  t.after(done);
  const amqp = attach(pool, 'amqp://hang.example:5672', 'hang');
  let settled = false;
  const stopping = pool.stop({ confirmTimeout: 0 }).then(v => { settled = true; return v; });
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  t.mock.timers.tick(4999);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  assert.strictEqual(settled, false, 'still waiting at 4999 ms');
  t.mock.timers.tick(1);
  assert.deepStrictEqual(await stopping, [0]);
  assert.strictEqual(amqp.stream.destroyed, true);
  assert.strictEqual(timedOut(infos)[0].closeTimeout, 5000);
});

test('#105 a bad closeTimeout rejects with a TypeError before anything stops', async t => {
  const { pool, done } = setup();
  t.after(done);
  const amqp = attach(pool, 'amqp://ok.example:5672', 'ok');
  const rows = { negative: -1, fraction: 1.5, string: '5', 'past the max': MAX_WAIT + 1,
    null: null, NaN: NaN, Infinity: Infinity };
  for (const [row, closeTimeout] of Object.entries(rows)) {
    await assert.rejects(pool.stop({ confirmTimeout: 0, closeTimeout }),
      { name: 'TypeError', message: /^stop: closeTimeout must be a whole number from 0 to / },
      row);
  }
  assert.strictEqual(amqp.closeCalls, 0, 'no connection was closed');
  assert.strictEqual(pool.connections.length, 1);
  assert.doesNotThrow(() => pool.publish({ n: 1 }), 'the pool still runs');
  assert.deepStrictEqual(await pool.stop({ confirmTimeout: 0, closeTimeout: MAX_WAIT }), [0]);
});
