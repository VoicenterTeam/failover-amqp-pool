// isClosed: the public read of close()'s finality; false while a channel is only down
const { test } = require('node:test');
const assert = require('node:assert');
const Channel = require('../Channel');
const { FakeAmqpChannel } = require('./helpers/fakes');

function make() {
  const connection = {
    alive: true,
    url: 'amqp://u:p@rabbit.example:5672',
    amqpConnection: { createConfirmChannel: () => Promise.resolve(new FakeAmqpChannel()) },
  };
  return new Channel(connection, {});
}

test('isClosed is false on a new channel', () => {
  assert.strictEqual(make().isClosed, false);
});

test('isClosed stays false while the channel is down', async () => {
  const channel = make();
  const up = new Promise((r) => channel.once('ready', r));
  channel.create();
  await up;
  channel.amqpChannel.emit('close');
  assert.strictEqual(channel.isAlive, false);
  assert.strictEqual(channel.isClosed, false);
});

test('isClosed is true after close(), alive or not', async () => {
  const channel = make();
  const up = new Promise((r) => channel.once('ready', r));
  channel.create();
  await up;
  await channel.close();
  assert.strictEqual(channel.isClosed, true);
  const fresh = make();
  await fresh.close();
  assert.strictEqual(fresh.isClosed, true);
});
