// #105: stop() takes closeTimeout. test/i105-types.test.js compiles this file; without the
// StopOptions field the call below fails with TS2353.
import AMQPPool = require('../..');

declare const pool: AMQPPool;

async function shutdown(): Promise<number[]> {
    return pool.stop({ confirmTimeout: 2000, closeTimeout: 3000 });
}
const options: AMQPPool.StopOptions = { closeTimeout: 0 };
shutdown().then(() => pool.stop(options));
