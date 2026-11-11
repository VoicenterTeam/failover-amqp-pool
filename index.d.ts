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

    /** Retries cached messages, one per tick (default every 2000 ms). */
    start(msgCacheInterval?: number): void;
    /**
     * Stops the retry timer, removes the pool's SIGINT listener and the listeners it added to
     * its connections and channels, and closes every connection. The app's own listeners
     * ('info', 'error' and any other) stay, and a stopped pool emits nothing more, so a
     * teardown error is not heard. (A SIGINT stop gives those listeners its one 'info' or
     * 'error'.) Takes no callback. Resolves, once each connection is closed and removed, with
     * one entry per connection: its position when stop() began.
     * A stopped pool is final: addConnection(), createConnection(), createChannel() and start()
     * throw Error('Pool is stopped') after it.
     */
    stop(): Promise<number[]>;
    /** Adds the connections and channels of a config array; returns the new channels' ids. */
    addConnection(amqpConfigArray: Array<AMQPPool.AmqpConfig>): string[];

    /**
     * `filter`: 'rr' round-robins over the alive channels, 'all' publishes on each, a function
     * picks channels from the alive ones (nothing returned: the message is cached), and
     * omitted, or any other string, publishes on the first alive channel. Without an alive
     * channel the message is cached. A publish that fails on a channel is cached too, and an
     * 'error' is emitted.
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
    /** A message consumed on any channel. */
    on(event: 'channelMessage', listener: (msg: ConsumeMessage) => void): this;
    /** Connection, channel and publish errors: an Error, or an object with a `message`. */
    on(event: 'error', listener: (error: any) => void): this;
    /** A string or an object with a `message`. */
    on(event: 'info', listener: (info: any) => void): this;
    /** Other event names. Excludes the names above so a mistyped listener for one of them is
     *  a type error, not a fallback match. */
    on<E extends string | symbol>(
        event: E extends AMQPPool.PoolEvent ? never : E,
        listener: (...args: any[]) => void
    ): this;

    /** Same overloads as on(). */
    once(event: 'ready' | 'recreated', listener: (channel: AMQPPool.Channel) => void): this;
    once(event: 'close', listener: (url?: string) => void): this;
    once(event: 'channelMessage', listener: (msg: ConsumeMessage) => void): this;
    once(event: 'error' | 'info', listener: (payload: any) => void): this;
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
    /** Returns the new connection's index. */
    createConnection(
        url: string,
        connection: AMQPPool.ConnectionConf
    ): number;
    /** Returns the new channel's id. */
    createChannel(
        connectionIndex: number | string,
        channel: AMQPPool.ChannelConf
    ): string;
}

declare namespace AMQPPool {

    /** Every event name the pool emits with a typed payload. */
    type PoolEvent = 'ready' | 'recreated' | 'close' | 'channelMessage' | 'error' | 'info';

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
        'ready' | 'recreated' | 'message' | 'channelMessage' | 'close' | 'error' | 'info';

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
        on<E extends string | symbol>(
            event: E extends ChannelEvent ? never : E,
            listener: (...args: any[]) => void
        ): this;

        hasCachedAck(): boolean;
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
