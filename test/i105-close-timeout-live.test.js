'use strict';
// #105 on a live broker: a pool connection whose amqplib close() is made to hang. stop() gives
// up after closeTimeout, destroys the real socket, and the broker drops the connection. Needs
// FAMQP_TEST_URL and FAMQP_TEST_MGMT_URL.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const amqplib = require('amqplib');
const AMQPPool = require('..');
const { MGMT, mgmt, until, connectionNamed } = require('./helpers/mgmt');

const URL_ = process.env.FAMQP_TEST_URL;
const skip = !URL_ ? 'FAMQP_TEST_URL not set' : !MGMT ? 'FAMQP_TEST_MGMT_URL not set' : false;

test('#105 live: a hung close is abandoned after closeTimeout and the socket is gone',
  { skip, timeout: 30000 }, async t => {
    const u = new URL(URL_);
    const name = `i105-${process.pid}`;
    const pool = new AMQPPool([{
      connection: { host: u.hostname, port: Number(u.port),
        username: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
        reconnectInterval: 100, connection_name: name },
      channel: { exchange: { name: `${name}.x`, type: 'direct' } },
    }]);
    const errors = [];
    const infos = [];
    pool.on('error', e => errors.push(e));
    pool.on('info', i => infos.push(i));
    const warnings = [];
    const onWarning = w => warnings.push(w);
    process.on('warning', onWarning);
    t.after(async () => {
      process.off('warning', onWarning);
      await pool.stop({ confirmTimeout: 0, closeTimeout: 0 }).catch(() => {});
      const conn = await amqplib.connect(URL_);
      try {
        const ch = await conn.createChannel();
        await ch.deleteExchange(`${name}.x`);
      } finally {
        await conn.close();
      }
    });
    await new Promise(resolve => pool.once('ready', resolve));
    const broker = await connectionNamed(`${name}_${os.hostname}`);
    assert.ok(broker, 'the broker lists the pool connection');

    const connection = pool.connections[0];
    const stream = connection.amqpConnection.connection.stream;
    connection.amqpConnection.close = () => new Promise(() => {});  // the broker never answers

    const t0 = Date.now();
    assert.deepStrictEqual(await pool.stop({ confirmTimeout: 0, closeTimeout: 300 }), [0]);
    const took = Date.now() - t0;
    assert.ok(took >= 290 && took < 5000, `took ${took} ms`);
    assert.strictEqual(stream.destroyed, true);
    assert.strictEqual(pool.connections.length, 0);
    assert.strictEqual(infos.filter(i => i?.message === 'connection close timed out').length, 1);

    // the broker sees the socket go
    await until(async () => {
      const all = await mgmt('GET', 'connections');
      return !all.some(c => c.client_properties?.connection_name === `${name}_${os.hostname}`);
    }, 'the broker to drop the connection');
    await new Promise(r => setTimeout(r, 200));
    assert.deepStrictEqual(warnings, [], 'no process warning from the destroyed socket');
  });
