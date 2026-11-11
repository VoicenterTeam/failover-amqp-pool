// Stub channels and a pool that never dials out, for tests of what the pool does with them.
const AMQPPool = require('../..');
const { offline } = require('./offline');

function fake(name, { closed, failures = 0 } = {}) {
  const ch = { name, _id: name, got: [], failures, isClosed: closed,
    publish(msg) {
      if (ch.failures > 0) { ch.failures--; throw new Error(`${name} is dead`); }
      ch.got.push(msg);
    } };
  return ch;
}
function rig(t, { alive = [], all = alive } = {}) {
  offline(t);
  const pool = new AMQPPool([{ connection: { host: '127.0.0.1', port: 5672 }, channel: {} }]);
  t.after(() => pool.stop());
  const heard = { error: [], info: [] };
  for (const event of Object.keys(heard)) pool.on(event, e => heard[event].push(e));
  pool.getAliveChannels = () => alive.slice();
  pool.getAllChannels = () => all.slice();
  return { pool, heard, setAll: list => { all = list; }, setAlive: list => { alive = list; } };
}

module.exports = { fake, rig };
