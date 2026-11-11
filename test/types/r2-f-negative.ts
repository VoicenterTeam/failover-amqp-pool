// Each statement tagged `// TSnnnn` raises exactly that error on its line, and no other line
// raises any; test/r2-f-types.test.js compares.
import AMQPPool = require('../..');

declare const pool: AMQPPool;
declare const channel: AMQPPool.Channel;

channel.waitConfirmed('1000'); // TS2345 milliseconds, a number
channel.resend({ msg: 'x' }); // TS2345 a handed-back entry, with its method
pool.on('unconfirmed', (entry: AMQPPool.UnconfirmedEntry) => {}); // TS2769 an array of entries
