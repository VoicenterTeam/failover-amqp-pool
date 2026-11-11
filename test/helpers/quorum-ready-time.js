// Measures what the live quorum rows of queue-defaults.test.js wait for (#78): the time from
// new AMQPPool with a quorum queue that does not exist to the pool's first 'ready'. Prints one
// JSON record per run, then deletes the queue and exchange it made.
//   node test/helpers/quorum-ready-time.js <amqp url> <runs>
// For a loaded measurement, run it while `npm test` runs with both URLs on the same broker.
const amqplib = require('amqplib');
const AMQPPool = require('../..');

async function once(url, i) {
  const u = new URL(url);
  const name = `famqp-qrt-${process.pid}-${Date.now()}-${i}`;
  const exchange = `${name}-x`;
  const started = process.hrtime.bigint();
  const pool = new AMQPPool([{
    connection: { host: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), ssl: false, reconnectInterval: 50 },
    channel: { prefetch: 5, exchange: { name: exchange, type: 'fanout' },
      binding: { enabled: true },
      queue: { name, options: { arguments: { 'x-queue-type': 'quorum' } } } },
  }]);
  const errors = [];
  pool.on('error', e => errors.push(String(e?.message ?? e)));
  try {
    const ms = await new Promise((resolve, reject) => {
      const giveUp = setTimeout(() => reject(new Error('no ready within 60 s')), 60000);
      pool.once('ready', () => {
        clearTimeout(giveUp);
        resolve(Number(process.hrtime.bigint() - started) / 1e6);
      });
    });
    console.log(JSON.stringify({ level: 'info', msg: 'quorum ready', run: i, ms, errors }));
  } finally {
    const stopped = pool.stop();
    pool.on('error', () => {});
    await stopped.catch(() => {});
    const admin = await amqplib.connect(url);
    const ch = await admin.createChannel();
    await ch.deleteQueue(name).catch(() => {});
    await ch.deleteExchange(exchange).catch(() => {});
    await admin.close();
  }
}

(async () => {
  const [url, runs] = process.argv.slice(2);
  const usage = 'usage: quorum-ready-time.js <amqp url> <runs>';
  if (!url || !(Number(runs) >= 1)) throw new Error(usage);
  for (let i = 0; i < Number(runs); i++) await once(url, i);
})().catch(e => {
  console.log(JSON.stringify({ level: 'error', msg: String(e?.message ?? e) }));
  process.exitCode = 1;
});
