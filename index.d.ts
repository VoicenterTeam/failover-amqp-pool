import { EventEmitter } from 'events';
import type { ChannelModel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';

/**
 * The pool. `module.exports` of the package is this class, so import it with
 * `import AMQPPool = require('@voicenter-team/failover-amqp-pool')`, or with a default import
 * under `esModuleInterop`. The config types, `Channel` and `Connection` live in the namespace.
 */
declare class AMQPPool extends EventEmitter {

    /** The connections, in creation order. */
    connections: Array<AMQPPool.Connection>;
    /** Messages waiting for an alive channel; `start()` retries them. */
    msgCache: Array<AMQPPool.CachedMessage>;
    rr_i: number;
    interval: ReturnType<typeof setInterval> | undefined;

    constructor(amqpConfigArray: Array<AMQPPool.AmqpConfig>);

    /**
     * Retries cached messages every msgCacheInterval ms (default 2000): each tick sends, in
     * publish order, every cached message a live channel takes.
     * @throws {AMQPPool.PoolStoppedError} after stop().
     */
    start(msgCacheInterval?: number): void;
    /**
     * Stops the retry timer and removes the pool's SIGINT listener. Then it waits up to
     * `confirmTimeout` ms (default 5000) for the broker to confirm what the channels hold, and
     * reports what is still unconfirmed once, with everything left in msgCache, which it
     * empties (never-sent messages as reason 'unsent'): one 'unconfirmed' event with every
     * entry, and one 'info' { message: 'unconfirmed messages at stop', count, unsent }. Then it
     * removes the listeners it added to its connections and channels, and closes every
     * connection. The app's own listeners ('info', 'error' and any other) stay, and a stopped
     * pool emits nothing more, so a teardown error is not heard. (A SIGINT stop gives those
     * listeners its one 'info' or 'error'.) Takes no callback. Resolves, once each connection
     * is closed and removed, with one entry per connection: its position when stop() began.
     * Rejects with a TypeError, before anything stops, for a confirmTimeout that is not a
     * whole number from 0 to 2147483647.
     * A stopped pool is final: addConnection(), createConnection(), createChannel(), start() and
     * publish() throw a {@link AMQPPool.PoolStoppedError} after it.
     */
    stop(options?: AMQPPool.StopOptions): Promise<number[]>;
    /**
     * Adds the connections and channels of a config array; returns the new channels' ids.
     * @throws {AMQPPool.PoolStoppedError} after stop().
     */
    addConnection(amqpConfigArray: Array<AMQPPool.AmqpConfig>): string[];

    /**
     * `filter`: 'rr' round-robins over the alive channels, 'all' publishes on each, a function
     * picks channels from the alive ones (nothing returned: the message is cached), and
     * omitted, or any other string, publishes on the first alive channel. Without an alive
     * channel the message is cached. A publish that fails on a channel is cached too, and an
     * 'error' is emitted. A cached 'all' message is retried on the channel that failed only; if
     * that channel is gone (removed, or closed with close() and still listed) it is dropped, a
     * closed one with an 'info' event
     * { message: 'cached message dropped', messageId, channelId, reason }.
     * @throws {AMQPPool.PoolStoppedError} after stop().
     */
    publish(
        msg: string | object,
        filter?: 'rr' | 'all' | (string & {}) | AMQPPool.PublishFilter,
        topic?: string,
        props?: AMQPPool.PublishOptions
    ): void;
    /** Routes by msg.properties.channelId; when no channel has that id (it was re-created), an
     *  'info' event { message: 'stale ack dropped', messageId, channelId, reason } is emitted. */
    ack(msg: ConsumeMessage): void;
    /** Same rule as ack(), with message 'stale nack dropped'. */
    nack(msg: ConsumeMessage): void;

    /** First successful create of each channel. Fires once per Channel. */
    on(event: 'ready', listener: (channel: AMQPPool.Channel) => void): this;
    /** Each later re-create of the same Channel (channel or connection recovery). */
    on(event: 'recreated', listener: (channel: AMQPPool.Channel) => void): this;
    /** A connection closed (its credential-free url), or a channel closed (no argument). */
    on(event: 'close', listener: (url?: string) => void): this;
    /** A connection connected, on each connect and reconnect (its credential-free url). */
    on(event: 'connection', listener: (url: string) => void): this;
    /** A message consumed on any channel. */
    on(event: 'channelMessage', listener: (msg: ConsumeMessage) => void): this;
    /** Connection, channel and publish errors: an Error, or an object with a `message`. */
    on(event: 'error', listener: (error: any) => void): this;
    /** A string or an object with a `message`. */
    on(event: 'info', listener: (info: any) => void): this;
    /** Only from stop(): the hand-backs still cached, those handed back during its wait, and
     *  what was still unconfirmed when the wait ended, each with the id of the channel that
     *  held it; then every message cached unsent, reason 'unsent', channelId null. While the
     *  pool runs, handed-back messages are re-sent. */
    on(event: 'unconfirmed', listener: (entries: Array<AMQPPool.StopEntry>) => void): this;
    /** Other event names. Excludes the names above so a mistyped listener for one of them is
     *  a type error, not a fallback match. */
    on<E extends string | symbol>(
        event: E extends AMQPPool.PoolEvent ? never : E,
        listener: (...args: any[]) => void
    ): this;

    /** Same overloads as on(). */
    once(event: 'ready' | 'recreated', listener: (channel: AMQPPool.Channel) => void): this;
    once(event: 'close', listener: (url?: string) => void): this;
    once(event: 'connection', listener: (url: string) => void): this;
    once(event: 'channelMessage', listener: (msg: ConsumeMessage) => void): this;
    once(event: 'error' | 'info', listener: (payload: any) => void): this;
    once(event: 'unconfirmed', listener: (entries: Array<AMQPPool.StopEntry>) => void): this;
    once<E extends string | symbol>(
        event: E extends AMQPPool.PoolEvent ? never : E,
        listener: (...args: any[]) => void
    ): this;

    getAliveChannels(): Array<AMQPPool.Channel>;
    /** `undefined` when the connection has no channel with this hash. */
    getChannelByHash(
        connectionIndex: number | string,
        hash: string
    ): AMQPPool.Channel | undefined;
    getAllChannels(): Array<AMQPPool.Channel>;
    /** The channels whose current `_id` is this one: none after a re-create. */
    getChannelById(id: string): Array<AMQPPool.Channel>;
    /** Closes and removes the channels with this id. Resolves with each one's position. */
    removeChannelById(id: string): Promise<number[]>;

    /** The index as the string key of the connection, or false when there is no such url. */
    getConnectionIndexByUrl(url: string): string | false;
    /**
     * Returns the new connection's index.
     * @throws {AMQPPool.PoolStoppedError} after stop().
     */
    createConnection(
        url: string,
        connection: AMQPPool.ConnectionConf
    ): number;
    /**
     * Returns the new channel's id.
     * @throws {AMQPPool.PoolStoppedError} after stop().
     */
    createChannel(
        connectionIndex: number | string,
        channel: AMQPPool.ChannelConf
    ): string;
}

declare namespace AMQPPool {

    /**
     * What addConnection(), createConnection(), createChannel(), start() and publish() throw
     * after stop(): Error('Pool is stopped'). Match on `code`, not on the message.
     */
    interface PoolStoppedError extends Error {
        readonly code: 'POOL_STOPPED';
    }

    /** Every event name the pool emits with a typed payload. */
    type PoolEvent =
        'ready' | 'recreated' | 'close' | 'connection' | 'channelMessage' | 'error' | 'info' |
        'unconfirmed';

    interface StopOptions {
        /** How long stop() waits for confirms, ms. Default 5000. */
        confirmTimeout?: number;
    }

    /** The channel's own error a 'closed' entry carries: 404 or 406, say. */
    interface UnconfirmedCause {
        code: number | undefined;
        message: string;
    }

    interface UnconfirmedCommon {
        /** As sent: an object was JSON already. */
        msg: string;
        /** How many times the pool sent it again. */
        attempts: number;
        /** How many times the broker refused it (a nack, or a close with a cause). The pool
         *  drops a message refused once more after 5 re-sends; connection drops never count. */
        refusals: number;
        /** 'nack' and 'closed' from the broker; 'timeout' from waitConfirmed(). */
        reason: 'nack' | 'closed' | 'timeout';
        /** The error the channel closed with, on every message that close hands back. null for
         *  a connection drop, a nack or a timeout. */
        cause: UnconfirmedCause | null;
    }

    /** A message a Channel holds until the broker confirms it, handed back by 'unconfirmed'
     *  or returned by waitConfirmed(). */
    type UnconfirmedEntry =
        (UnconfirmedCommon & { method: 'publish', topic: string, props: PublishOptions }) |
        (UnconfirmedCommon & {
            method: 'sendToQueue', queue: string, props: Options.Publish | undefined
        });

    /** What a Channel's 'unconfirmed' event carries: never 'timeout', which only
     *  waitConfirmed() returns. */
    type HandedBackEntry = UnconfirmedEntry & { reason: 'nack' | 'closed' };

    /** An entry in stop()'s report, with the id of the channel that held it. */
    type StopEntry = (UnconfirmedEntry & { channelId: string }) | UnsentEntry;

    /** In stop()'s report, after the hand-backs: a message publish() cached because no channel
     *  took it, never written to amqplib. Its msg is as publish() got it. */
    interface UnsentEntry {
        method: 'publish';
        msg: string | object;
        topic: string | undefined;
        props: PublishOptions | undefined;
        /** The publish strategy it was cached with, to publish it again the same way. */
        filter?: 'rr' | 'all' | (string & {}) | PublishFilter;
        attempts: 0;
        refusals: 0;
        reason: 'unsent';
        cause: null;
        channelId: null;
    }

    // Actually options are different for Queue, Exchange, Channel and so on...
    // Here we just put all the things into one object and make all props non mandatory
    // So, one interface can work for various things
    interface OptionsConf {
        /** Queue: default false; true for a queue the channel names itself (not quorum, stream) */
        exclusive?: boolean,
        /** Queue: default true; false for a queue the channel names itself (not quorum, stream) */
        durable?: boolean,
        /**
         * Queue arguments, passed to the broker as given. A quorum queue
         * ('x-queue-type': 'quorum') also gets 'x-consumer-timeout': 7200000 unless set;
         * a classic queue gets no default.
         */
        arguments?: any,
        /**
         * Queue expiry in ms. 'none' is for dynamic queues only (a named queue is refused).
         * A stream queue refuses x-expires and the message ttl: set both to 'none'.
         */
        expires?: number | 'none',
        /** Message ttl in ms (default 3600000), or 'none' for no ttl. */
        messageTtl?: number | 'none',
        deadLetterExchange?: string,
        deadLetterRoutingKey?: string,
        maxLength?: number,
        maxPriority?: number,
        /** RabbitMQ's 'drop-head' or 'reject-publish' */
        overflow?: string,
        queueMode?: string,
        autoDelete?: boolean,
        alternateExchange?: string,
        consumerTag?: string,
        noLocal?: boolean
    }

    /** amqplib's publish options, plus a per-call exchange that replaces the channel's. */
    interface PublishOptions extends Options.Publish {
        exchange?: string
    }

    interface QueueConf {
        /** Left out: the channel declares a dynamic queue of its own when it consumes. */
        name?: string,
        options?: OptionsConf
    }

    interface ExchangeConf {
        name: string,
        /** Left out: the exchange is checked, not declared. */
        type?: string,
        options?: OptionsConf
    }

    interface BindingConf {
        enabled?: boolean,
        pattern?: string,
        /** Binding arguments (e.g. headers); an array makes one binding per entry. */
        options?: Record<string, any> | Array<Record<string, any>>
    }

    interface ConnectionConf {
        host: string,
        port: number,
        ssl?: boolean,
        username?: string,
        password?: string,
        vhost?: string,
        heartbeat?: number,
        /** Connect timeout (ms, default 5000) */
        timeout?: number,
        /** Shown in the broker's connection list, suffixed with the hostname */
        connection_name?: string,
        /** Connection reconnect interval, and the first wait before retrying a failed
         *  channel create (ms, default 1500) */
        reconnectInterval?: number,
        /** Ceiling for the channel create retry wait, which doubles per consecutive
         *  failure (ms, default 30000) */
        channelRetryMaxInterval?: number
    }

    interface ChannelConf {
        /** Left out: a channel on the default exchange (sendToQueue, consume by queue name). */
        exchange?: ExchangeConf
        queue?: QueueConf,
        binding?: BindingConf,
        topic?: string,
        /** Defaults for each publish on this channel */
        options?: PublishOptions,
        /** Merged into every object message published on this channel */
        msg?: object,
        autoConsume?: boolean,
        prefetch?: number,
    }

    interface AmqpConfig {
        connection: ConnectionConf,
        channel?: ChannelConf,
        /** Several channels on this connection; used instead of `channel`. */
        channels?: Array<ChannelConf>,
        /** Merged under `channel` (Object.assign), so `channel` may hold only what differs. */
        defaultChannelSettings?: ChannelConf
    }

    /** What `start()` retries. */
    interface CachedMessage {
        msg: string | object,
        filter?: 'rr' | 'all' | (string & {}) | PublishFilter,
        topic?: string,
        props?: PublishOptions
    }

    /** A channel, several, or nothing (cache the message) out of the alive channels. */
    type PublishFilter = (channels: Array<Channel>) =>
        Channel | Array<Channel> | null | undefined | false;

    type ChannelEvent =
        'ready' | 'recreated' | 'message' | 'channelMessage' | 'close' | 'error' | 'info' |
        'unconfirmed';

    /** Not exported at runtime: reach one through `pool.getAllChannels()` or the 'ready' event. */
    interface Channel extends EventEmitter {
        hash: string;
        /** Changes on every re-create */
        _id: string;
        connection: Connection;
        /** The current amqplib channel, null before the first create */
        amqpChannel: ConfirmChannel | null;
        exchange?: ExchangeConf;
        queue: QueueConf;
        topic: string;
        options: PublishOptions;

        /** The queue name when there is one. */
        readonly isConsumable: string | undefined;
        /** Reading it re-creates a dead channel when its connection is up. */
        alive: boolean;
        /** Whether the channel is open, without the re-create that reading `alive` starts. */
        readonly isAlive: boolean;
        /** True once close() was called: the channel is final, though it may still be listed. */
        readonly isClosed: boolean;
        /** The queue options as the channel declares them. */
        readonly queueOptions: Options.AssertQueue & { noAck: boolean };
        readonly exchangeOptions: Options.AssertExchange;
        /** Starts the create; a closed channel does nothing. Its result arrives as events. */
        create(): void;
        /** Final: the channel is not re-created afterwards. Resolves true when closed or there
         *  was nothing to close, false when amqplib refused (already closed). Never rejects. */
        close(): Promise<boolean>;

        /** Throws Error('Channel is dead!') on a dead channel, after an 'error' event. */
        publish(
            msg: string | object,
            topic?: string,
            options?: PublishOptions
        ): void;

        /** Without a queue name it declares a dynamic queue first. */
        consume(queueName?: string): void;

        /** A message delivered on a previous (closed) amqplib channel is not acked: an 'info'
         *  event { message: 'stale ack dropped', messageId, channelId, reason } is emitted
         *  instead. */
        ack(msg: ConsumeMessage): void;
        /** Same stale-message rule as ack(), with message 'stale nack dropped'. */
        nack(msg: ConsumeMessage): void;

        on(event: 'ready' | 'recreated', listener: (channel: Channel) => void): this;
        on(event: 'message' | 'channelMessage', listener: (msg: ConsumeMessage) => void): this;
        on(event: 'close', listener: () => void): this;
        on(event: 'error' | 'info', listener: (payload: any) => void): this;
        /** A nack hands back one message; a close of the amqplib channel, all it held, in one
         *  event and in publish order. A close the channel asked for itself hands back nothing
         *  while the connection is up. Fires on the next tick. */
        on(event: 'unconfirmed', listener: (entries: Array<HandedBackEntry>) => void): this;
        on<E extends string | symbol>(
            event: E extends ChannelEvent ? never : E,
            listener: (...args: any[]) => void
        ): this;

        hasCachedAck(): boolean;
        /** Resolves with [] once the broker has confirmed everything the channel holds, or after
         *  `ms` (default 5000) with what is still unconfirmed, reason 'timeout'. Those are
         *  released: nothing hands them back later. Never rejects. Throws a TypeError for an ms
         *  that is not a whole number from 0 to 2147483647. */
        waitConfirmed(ms?: number): Promise<Array<UnconfirmedEntry>>;
        /** Sends a handed-back entry again, as publish() or sendToQueue() sent it, and throws as
         *  they do. Its next hand-back carries attempts + 1. */
        resend(entry: UnconfirmedEntry): void;
        /**
         * Sends through the default exchange. `options` are amqplib's and are not changed.
         * Throws Error('Channel is dead!') on a dead channel, after an 'error' event.
         */
        sendToQueue(
            queue: string,
            msg: string | object,
            options?: Options.Publish
        ): void;
    }

    /** Not exported at runtime: reach one through `pool.connections`. */
    interface Connection extends EventEmitter {
        url: string;
        /** The url without its username and password */
        safeUrl: string;
        config: ConnectionConf;
        channels: Array<Channel>;
        /** The amqplib connection; null before the first connect, undefined after disconnect() */
        amqpConnection: ChannelModel | null | undefined;

        alive: boolean;

        start(): void;
        connection(): void;

        addChannel(channel: Channel): void;
        removeChannel(channel: Channel): void;

        /** Final. Resolves true when closed or there was nothing to close, false when amqplib's
         *  close() rejected; never rejects. */
        disconnect(): Promise<boolean>;

        on(event: 'close', listener: (info: { msg: string, url: string }) => void): this;
        on(event: 'error', listener: (info: { error: any, url: string }) => void): this;
        on(event: 'info', listener: (info: any) => void): this;
        on<E extends string | symbol>(
            event: E extends 'close' | 'error' | 'info' ? never : E,
            listener: (...args: any[]) => void
        ): this;
    }
}

export = AMQPPool;
