// #75: a null delivery (the broker cancelled the consumer) acts on the amqplib channel that
// delivered it, and starts no create while one is in flight.
const { test } = require('node:test');
const assert = require('node:assert');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');

// hold(n): the n-th createConfirmChannel (0-based) waits until release() is called
function setup(hold = -1) {
  const made = [];
  let calls = 0;
  let release;
  const connection = {
    alive: true, url: 'amqp://u:p@rabbit.example:5672', reconnectInterval: 1, config: {},
    amqpConnection: {
      createConfirmChannel: () => {
        const c = new FakeAmqpChannel();
        c.closes = 0;
        c.close = () => { c.closes++; c.emit('close'); return Promise.resolve(); };
        const n = calls++;
        const add = () => { made.push(c); return c; };
        if (n !== hold) return Promise.resolve(add());
        return new Promise(r => { release = () => r(add()); });
      },
    },
  };
  const channel = new Channel(connection, { queue: { name: 'work' } });
  channel.on('error', () => {});
  return { channel, made, calls: () => calls, release: () => release() };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
};
async function consuming(ctx) {
  const up = new Promise(r => ctx.channel.once('ready', r));
  ctx.channel.create();
  await up;
  ctx.channel.consume();
  await settle();
}

test('#75 a null from a replaced channel leaves the current one open and starts no create',
  async () => {
  const ctx = setup();
  await consuming(ctx);
  const again = new Promise(r => ctx.channel.once('recreated', r));
  ctx.channel.create();   // the channel is replaced; made[0] can still deliver late
  await again;
  await settle();
  ctx.made[0].consumers[0](null);
  await settle();
  assert.strictEqual(ctx.made[1].closes, 0, 'the current channel stays open');
  assert.strictEqual(ctx.calls(), 2, 'no create started');
  assert.strictEqual(ctx.channel.isAlive, true);
});

test('#75 a null from the current channel closes it and re-creates it once, not twice',
  async () => {
  const ctx = setup(1);
  await consuming(ctx);
  ctx.made[0].consumers[0](null);
  assert.strictEqual(ctx.made[0].closes, 1, 'the delivering channel is closed');
  assert.strictEqual(ctx.calls(), 2, 'one create started');
  ctx.made[0].consumers[0](null);   // a second null while that create is in flight
  assert.strictEqual(ctx.calls(), 2, 'no second create while one is in flight');
  ctx.release();
  await settle();
  assert.strictEqual(ctx.calls(), 2);
  assert.strictEqual(ctx.made[1].consumers.length, 1, 'consuming on the new channel');
});
