// Every line below must be a type error: an unused @ts-expect-error fails the compile.
import AMQPPool = require('../..');

declare const pool: AMQPPool;
declare const channel: AMQPPool.Channel;

// @ts-expect-error stop() takes no callback
pool.stop(() => {});
// @ts-expect-error sendToQueue takes three arguments at most
channel.sendToQueue('q', 'hi', {}, 'extra');
// @ts-expect-error the queue is a name, not a queue config
channel.sendToQueue({ name: 'q' }, 'hi');
// @ts-expect-error a 'ready' listener gets a Channel
pool.on('ready', (channel: number) => {});
// @ts-expect-error expires is a number or 'none'
const bad: AMQPPool.OptionsConf = { expires: 'never' };
// @ts-expect-error stop() resolves with numbers, not a boolean
const flag: Promise<boolean> = pool.stop();
