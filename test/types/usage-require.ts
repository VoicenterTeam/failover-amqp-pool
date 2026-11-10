// Compiled by test/types.test.js with `tsc --strict --noEmit`; never run.
import AMQPPool = require('../..');
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
}];

async function main(): Promise<void> {
    const pool = new AMQPPool(config);
    pool.on('ready', (channel: AMQPPool.Channel) => { channel.sendToQueue('q', 'hi'); });
    pool.on('recreated', channel => { channel.consume(); });
    pool.on('channelMessage', (msg: ConsumeMessage) => { pool.ack(msg); });
    pool.on('close', (url?: string) => { void url; });
    pool.on('error', error => { void error.message; });
    pool.on('anything-else', (...args) => { void args; });

    pool.start();
    pool.publish({ a: 1 }, 'all', 'topic', { persistent: true });
    pool.publish('text');
    const channel: AMQPPool.Channel | undefined = pool.getAllChannels()[0];
    if (channel) {
        channel.sendToQueue('q', { a: 1 });
        channel.sendToQueue('q', 'hi', { headers: { x: 1 }, persistent: true });
        const closed: boolean = await channel.close();
        void closed;
    }
    const disconnected: boolean = await pool.connections[0].disconnect();
    void disconnected;
    const stopped: number[] = await pool.stop();
    void stopped;
}
void main;
