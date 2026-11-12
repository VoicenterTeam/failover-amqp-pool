// #36 on real Channel, Connection and pool objects, only amqplib faked: a channel closed with
// close() and left listed drops its cached 'all' entry through start()'s own tick, with one
// 'info'. The retry tick is a node:test mock timer; nothing sleeps.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const amqplib = require('amqplib');
const AMQPPool = require('..');
const { FakeAmqpChannel } = require('./helpers/fakes');

const flush = () => new Promise(setImmediate);

// A two-channel pool whose amqplib connection makes FakeAmqpChannels; both channels ready.
async function readyPool(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const connection = Object.assign(new EventEmitter(), {
    creates: 0,
    createConfirmChannel() { this.creates++; return Promise.resolve(new FakeAmqpChannel()); },
    close() { Promise.resolve().then(() => this.emit('close')); return Promise.resolve(); },
  });
  t.mock.method(amqplib, 'connect', () => Promise.resolve(connection));
  const pool = new AMQPPool([{ connection: { host: 'rabbit.example', port: 5672 },
    channels: [{ exchange: { name: 'x' }, queue: { name: 'a' } },
      { exchange: { name: 'x' }, queue: { name: 'b' } }] }]);
  const heard = { error: [], info: [] };
  for (const event of Object.keys(heard)) pool.on(event, e => heard[event].push(e));
  t.after(() => pool.stop({ confirmTimeout: 0 }));
  for (let i = 0; i < 50 && pool.getAliveChannels().length < 2; i++) await flush();
  const [A, B] = pool.getAllChannels();
  assert.deepStrictEqual([A.isAlive, B.isAlive], [true, true]);
  return { pool, connection, heard, A, B };
}
const drops = heard => heard.info.filter(e => e.message === 'cached message dropped');

test('a closed, listed Channel: its failed \'all\' entry is dropped by start() with one info',
  async t => {
    const { pool, connection, heard, A, B } = await readyPool(t);
    B.amqpChannel.publishError = new Error('boom');
    pool.publish({ n: 1 }, 'all', undefined, { messageId: 'm-1' });
    assert.strictEqual(pool.msgCache.length, 1, 'B failed, its entry is cached');
    await B.close();
    assert.ok(pool.getAllChannels().includes(B), 'still listed');
    pool.start(10);
    t.mock.timers.tick(10);
    assert.strictEqual(pool.msgCache.length, 0);
    assert.deepStrictEqual(drops(heard), [{
      message: 'cached message dropped', messageId: 'm-1', channelId: B._id,
      reason: 'channel is closed'
    }]);
    t.mock.timers.tick(30);
    assert.strictEqual(drops(heard).length, 1, 'dropped once');
    assert.strictEqual(A.amqpChannel.published.length, 1, 'A got the message once');
    assert.strictEqual(connection.creates, 2, 'the closed channel was not re-created');
    assert.strictEqual(B.isClosed, true);
  });

test('a Channel that is not closed keeps its entry and gets the retry, with no drop', async t => {
  const { pool, heard, A, B } = await readyPool(t);
  B.amqpChannel.publishError = new Error('boom');
  pool.publish({ n: 1 }, 'all');
  delete B.amqpChannel.publishError;
  pool.start(10);
  t.mock.timers.tick(10);
  assert.strictEqual(pool.msgCache.length, 0);
  assert.deepStrictEqual([A, B].map(c => c.amqpChannel.published.length), [1, 1]);
  assert.deepStrictEqual(drops(heard), []);
});
