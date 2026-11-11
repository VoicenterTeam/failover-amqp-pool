// #79's types: 'unconfirmed' on the pool and on a Channel, its entries, waitConfirmed(),
// resend() and stop()'s confirmTimeout. test/r2-f-types.test.js compiles this file.
import AMQPPool = require('../..');

declare const pool: AMQPPool;
declare const channel: AMQPPool.Channel;

pool.on('unconfirmed', (entries) => {
    for (const entry of entries) {
        const id: string = entry.channelId;
        const left: 'nack' | 'closed' | 'timeout' = entry.reason;
        const code: number | undefined = entry.cause?.code;
        if (entry.method === 'sendToQueue') {
            const queue: string = entry.queue;
        } else {
            const topic: string = entry.topic;
        }
    }
});
channel.on('unconfirmed', (entries: AMQPPool.UnconfirmedEntry[]) => {
    for (const entry of entries) channel.resend(entry);
});
async function shutdown(): Promise<void> {
    const left: AMQPPool.UnconfirmedEntry[] = await channel.waitConfirmed(1000);
    const tries: number[] = left.map(entry => entry.attempts);
    const closed: number[] = await pool.stop({ confirmTimeout: 2000 });
    await pool.stop();
}
