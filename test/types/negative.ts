// Every statement tagged `// TSnnnn` must raise exactly that error on its line, and no other
// line, or other error, may appear. test/types.test.js compiles this file as it is and compares.
import AMQPPool = require('../..');

declare const pool: AMQPPool;
declare const channel: AMQPPool.Channel;

pool.stop(() => {}); // TS2559 stop() takes no callback
channel.sendToQueue('q', 'hi', {}, 'extra'); // TS2554 three arguments at most
channel.sendToQueue({ name: 'q' }, 'hi'); // TS2345 the queue is a name
pool.on('ready', (channel: number) => {}); // TS2769 a 'ready' listener gets a Channel
const bad: AMQPPool.OptionsConf = { expires: 'never' }; // TS2322 number or 'none'
const flag: Promise<boolean> = pool.stop(); // TS2322 numbers, not a boolean
const asMethod: () => unknown = channel.isConsumable; // TS2322 a getter, not a method
const ids: number[] = pool.addConnection([]); // TS2322 channel ids are strings
const at: number | false = pool.getConnectionIndexByUrl('u'); // TS2322 the index is a string
channel.isClosed = true; // TS2540 isClosed is read-only
const code: AMQPPool.PoolStoppedError['code'] = 'STOPPED'; // TS2322 the code is POOL_STOPPED
