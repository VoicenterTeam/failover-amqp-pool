// #77: the stopped-pool error carries code POOL_STOPPED, so a caller matches it without the text.
const { test } = require('node:test');
const assert = require('node:assert');
const { rig } = require('./helpers/stubpool');

const stopped = { message: 'Pool is stopped', code: 'POOL_STOPPED' };
const throwers = [
  ['publish', (p) => p.publish({ a: 1 }, 'all')],
  ['start', (p) => p.start()],
  ['addConnection', (p) => p.addConnection([{ connection: { host: 'b', port: 1 }, channel: {} }])],
  ['createConnection', (p) => p.createConnection('amqp://b:5672', {})],
  ['createChannel', (p) => p.createChannel(0, {})],
];
for (const [name, call] of throwers) {
  test(`${name}() after stop() throws code POOL_STOPPED, message Pool is stopped`, async t => {
    const { pool } = rig(t);
    await pool.stop();
    assert.throws(() => call(pool), stopped);
  });
}
