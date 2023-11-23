// Actually options are different for Queue, Exchange, Channel and so on...
// Here we just put all the things into one object and make all props non mandatory
// So, one interface can work for various things
declare interface OptionsConf {
    exclusive?: boolean,
    durable?: boolean,
    arguments?: any,
    expires?: number,
    deadLetterExchange?: string,
    deadLetterRoutingKey?: string,
    maxLength?: number,
    maxPriority?: number,
    overflow?: boolean,
    queueMode?: string,
    autoDelete?: boolean,
    consumerTag?: string,
    noLocal?: boolean
}

declare interface QueueConf {
    name: string,
    options?: OptionsConf
}

declare interface ExchangeConf {
    name: string,
    type: string,
    options?: OptionsConf
}

declare interface BindingConf {
    enabled?: boolean,
    pattern?: string,
    options?: OptionsConf
}

declare interface ConnectionConf {
    host: string,
    port: number,
    ssl: boolean,
    username: string,
    password: string,
    vhost?: string,
    heartbeat?: number
}

declare interface ChannelConf {
    exchange: ExchangeConf
    queue?: QueueConf,
    binding?: BindingConf,
    topic?: string,
    options?: OptionsConf,
    msg?: any,
    autoConsume?: boolean,
    prefetch?: number,
}

declare interface AmqpConfig {
    connection: ConnectionConf,
    channel: ChannelConf
}

declare class AMQPPool {

    constructor(amqpConfigArray: Array<AmqpConfig>);

    start(msgCacheInterval?: number): void;
    stop(cbFn: Function): void;
    addConnection(connection: ConnectionConf): void;

    publish(
        msg: any,
        filter: string,
        topic: string,
        props: any
    ): void;
    ack(msg: any): void;
    nack(msg: any): void;

    getAliveChannels(): Array<Channel>;
    getChannelByHash(
        connectionIndex: number,
        hash: string
    ): Channel;
    getAllChannels(): Array<Channel>;
    getChannelById(id: string): Array<Channel>;

    getConnectionIndexByUrl(url: string): number | false;
    createConnection(
        url: string,
        connnection: ConnectionConf
    ): number;
    createChannel(
        connectionIndex: number,
        channel: ChannelConf
    ): void;
}

declare class Channel {

    constructor(
        connection: ConnectionConf,
        channel: ChannelConf
    );

    isConsumable(): boolean;
    alive(): boolean;
    alive(isAlive: boolean): void;
    queueOptions(): OptionsConf;
    create(): boolean;

    publish(
        msg: any,
        topic: string,
        options: OptionsConf
    ): void;

    consume(quueueName: string): void;

    ack(msg: any): void;
    nack(msg: any): void;

    hasCachedAck(): boolean;
    sendToQueue(
        queue: QueueConf,
        msg: any
    ): void;
}

declare class Connection {

    constructor(
        url: string,
        connection: ConnectionConf
    );

    alive(isAlive: boolean): void;
    alive(): boolean;

    start(): void;
    connection(): void;
    
    addChannel(channel: ChannelConf): void;
    removeChannel(channel: ChannelConf): void;

    disconnect(): void;

}