// Stub channels and an offline pool for the r2-e cache rows. A stub is alive while `up` is
// true; its publish throws while it is down, or while `failures` is above 0. Ticks are
// node:test mock timers, so every row pins a count of ticks and no clock.
const Connection = require('../Connection');
const AMQPPool = require('..');

function stub(name, { up = true, failures = 0, closed = false } = {}) {
  const ch = { name, _id: name, up, failures, isClosed: closed, got: [], tries: 0,
    publish(msg) {
      ch.tries++;
      if (!ch.up || ch.failures-- > 0) throw new Error(`${name} is dead`);
      ch.got.push(msg.n);
    } };
  return ch;
}

// A started pool over `all`, retrying every 10 ms of mock time
function rig(t, all) {
  const realStart = Connection.prototype.start;
  Connection.prototype.start = function () {};
  t.after(() => { Connection.prototype.start = realStart; });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const pool = new AMQPPool([{ connection: { host: '127.0.0.1', port: 5672 }, channel: {} }]);
  t.after(() => pool.stop());
  const heard = { error: [], info: [] };
  for (const event of Object.keys(heard)) pool.on(event, e => heard[event].push(e));
  pool.getAllChannels = () => all.slice();
  pool.getAliveChannels = () => all.filter(ch => ch.up);
  pool.start(10);
  return {
    pool, heard,
    cached: () => pool.msgCache.map(entry => entry.msg.n),
    tick: (n = 1) => t.mock.timers.tick(10 * n)
  };
}

module.exports = { stub, rig };
