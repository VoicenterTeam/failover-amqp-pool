// #79's types: 'unconfirmed' on the pool and on a Channel, its entries, waitConfirmed(),
// resend() and stop()'s confirmTimeout. test/r2-f-types.test.js compiles this file.
import AMQPPool = require('../..');

declare const pool: AMQPPool;
declare const channel: AMQPPool.Channel;

pool.on('unconfirmed', (entries) => {
    for (const entry of entries) {
        if (entry.reason === 'unsent') {
            // an 'all' copy unsent on one channel names that channel; others have none
            const where: string | null = entry.channelId;
            const msg: string | object = entry.msg;
            if (entry.filter === 'all') {
                pool.publish(entry.msg, entry.filter, entry.topic, entry.props);
            }
            continue;
        }
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
channel.on('unconfirmed', (entries) => {
    for (const entry of entries) {
        const why: 'nack' | 'closed' = entry.reason;
        const refused: number = entry.refusals;
        channel.resend(entry);
    }
});
async function shutdown(): Promise<void> {
    const left: AMQPPool.UnconfirmedEntry[] = await channel.waitConfirmed(1000);
    const tries: number[] = left.map(entry => entry.attempts);
    const closed: number[] = await pool.stop({ confirmTimeout: 2000 });
    await pool.stop();
}
