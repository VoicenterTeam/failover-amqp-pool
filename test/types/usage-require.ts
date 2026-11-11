// Compiled by test/types.test.js with `tsc --strict --noEmit`; never run.
import AMQPPool = require('../..');
import type { EventEmitter } from 'events';
import type { ConsumeMessage } from 'amqplib';

const config: AMQPPool.AmqpConfig[] = [{
    connection: { host: 'localhost', port: 5672, username: 'guest', password: 'guest' },
    channel: {
        // no exchange type: the exchange is only checked
        exchange: { name: 'events' },
        queue: { options: { expires: 'none' } },
        binding: { enabled: true, pattern: 'a.*', options: [{ x: 1 }, { x: 2 }] },
        options: { persistent: true },
    },
}, {
    // a partial channel over defaultChannelSettings, as index.js merges them
    connection: { host: 'other', port: 5672 },
    channel: { queue: { name: 'q' } },
    defaultChannelSettings: { exchange: { name: 'events' }, prefetch: 1 },
}, {
    // no exchange at all: the default exchange
    connection: { host: 'third', port: 5672 },
    channels: [{ queue: { name: 'q' }, autoConsume: true }],
}];

async function main(): Promise<void> {
    const pool = new AMQPPool(config);
    pool.on('ready', (channel: AMQPPool.Channel) => { channel.sendToQueue('q', 'hi'); });
    pool.on('recreated', channel => { const closed: boolean = channel.isClosed; void closed; channel.consume(); });
    pool.on('channelMessage', (msg: ConsumeMessage) => { pool.ack(msg); });
    pool.on('close', (url?: string) => { void url; });
    pool.on('error', error => { void error.message; });
    pool.on('anything-else', (...args) => { void args; });

    const emitter: EventEmitter = pool;           // the pool is an EventEmitter
    const listener = (): void => {};
    pool.on('info', listener);
    pool.off('info', listener);
    emitter.emit('info', 'x');

    const ids: string[] = pool.addConnection(config);
    const index: string | false = pool.getConnectionIndexByUrl('amqp://localhost:5672');
    void ids; void index;
    const strategy: string = 'rr';                // a plain string variable is accepted
    pool.publish('text', strategy);

    pool.start();
    pool.publish({ a: 1 }, 'all', 'topic', { persistent: true });
    pool.publish('text');
    const channel: AMQPPool.Channel | undefined = pool.getAllChannels()[0];
    if (channel) {
        channel.sendToQueue('q', { a: 1 });
        channel.sendToQueue('q', 'hi', { headers: { x: 1 }, persistent: true });
        const queueName: string | undefined = channel.isConsumable;   // a getter
        void queueName;
        const closed: boolean = await channel.close();
        void closed;
    }
    const disconnected: boolean = await pool.connections[0].disconnect();
    void disconnected;
    const stopped: number[] = await pool.stop();
    void stopped;
}
void main;
