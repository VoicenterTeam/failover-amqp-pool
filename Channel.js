const EventEmitter = require('events').EventEmitter,
      uuid = require('uuid').v4,
      hash = require('object-hash'),
      os = require('os'),
      { countSent, countConsumed, countSettled, thrownType } = require('./telemetry/metrics'),
      { publishing, processing } = require('./telemetry/spans')

// message -> the amqplib channel that delivered it; a delivery tag is valid only there
const deliveredOn = new WeakMap();

class Channel extends EventEmitter {
  #isAlive= false;
  #isConnecting = false;
  #closed = false;
  #readyEmitted = false;
  #consumingOn = null;
  #retryTimer = null;
  #retryDelay = 0;
  #temporaryQueue = false;
  constructor(connection, channelConfig) {
    super();
    this.hash = hash(channelConfig)
    this._id = this.#createID();
    this.connection = connection;
    this.amqpChannel = null;
    this.directives = ["ea", "qa"];
    this.exchange = channelConfig?.exchange;
    this.binding = channelConfig?.binding;
    this.queue = channelConfig?.queue || {};
    this.prefetch = false;
    this.topic = channelConfig?.topic || "";
    this.options = channelConfig?.options || {};
    this.alive = false;
    this.msg = channelConfig.msg
    this._cacheAck = [];
    this.autoConsume = channelConfig?.autoConsume || false;
    

    if (channelConfig.hasOwnProperty('prefetch')  && channelConfig.prefetch) {
      this.prefetch = !isNaN(parseInt(channelConfig.prefetch)) ? parseInt(channelConfig.prefetch) : false;
    }
  }
  // The exchange as telemetry names it: the configured one. A per-call exchange that differs is
  // _OTHER, so a caller's props cannot grow a series per value.
  #exchangeName(options){
    const configured = this.exchange?.name;
    return !options?.exchange || options.exchange === configured ? configured : '_OTHER';
  }
  // The queue as telemetry names it; a queue the channel named for itself is temporary
  get #destination(){
    return { name: this.queue?.name, temporary: this.#temporaryQueue }
  }
  get isConsumable(){
    return this.queue && this.queue.name
  }

  get alive(){
    // a failed create already has its retry scheduled; a dead connection re-creates its channels
    // on reconnect; create() does nothing once the channel is closed
    if(!this.#isAlive && !this.#isConnecting && !this.#retryTimer && this.connection.alive)
      this.create();
    return this.#isAlive;
  }
  set alive(isAlive){
    this.#isAlive = isAlive;
  }
  // alive without its side effect: reading `alive` re-creates a dead channel
  get isAlive(){
    return this.#isAlive;
  }
  get exchangeOptions(){
    return {
      exclusive: this?.exchange?.options?.exclusive || false,
      durable: this?.exchange?.options?.durable || false,
      autoDelete: this?.exchange?.options?.autoDelete || false,
      alternateExchange : this?.exchange?.options?.alternateExchange
    }
  }
  get queueOptions(){
    let messageTtl = 3600000;
    if(this?.queue?.options?.messageTtl === 'none') messageTtl = undefined
    if(Number.isInteger(this?.queue?.options?.messageTtl)) messageTtl = this?.queue?.options?.messageTtl

    return {
      exclusive: this?.queue?.options?.exclusive || false,
      durable: this?.queue?.options?.durable || false,
      arguments: this?.queue?.options?.arguments || { "x-consumer-timeout": 7200000 },
      noAck: !this.prefetch,
      expires: this?.queue?.options?.expires,
      messageTtl: messageTtl ,
      deadLetterExchange: this?.queue?.options?.deadLetterExchange,
      deadLetterRoutingKey: this?.queue?.options?.deadLetterRoutingKey,
      maxLength: this?.queue?.options?.maxLength,
      maxPriority: this?.queue?.options?.maxPriority,
      overflow: this?.queue?.options?.overflow,
      queueMode: this?.queue?.options?.queueMode,
      autoDelete: this?.queue?.options?.autoDelete,
      consumerTag: this?.queue?.options?.consumerTag,
      noLocal: this?.queue?.options?.noLocal
    }
  }
  // Final: no read, retry, reconnect or create in flight brings the channel back. Resolves true
  // when amqplib closed its channel or there was none to close, false when close() rejected: the
  // channel is already closed, so no 'close' event will come.
  close(){
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const wasAlive = this.#isAlive;
    this.#isAlive = false;
    if(wasAlive) this.emit('info', {message: `Channel closed`, id: this._id})
    // a create in flight has its amqplib channel too: it must not outlive the close
    if(!this.amqpChannel || !(wasAlive || this.#isConnecting)) return Promise.resolve(true);
    try {
      return Promise.resolve(this.amqpChannel.close()).then(() => true, () => false);
    } catch (error) {
      return Promise.resolve(false);   // already closed
    }
  }
  #createID(){
    return `${os.hostname}.${uuid()}`
  }
  async #createChannel(){
    if (this.connection.alive) {
      this.#isConnecting = true;
      return this.connection.amqpConnection.createConfirmChannel()
        .then((amqpChannel) => {
          if (this.#closed) {
            // closed while it was being created: nothing is waiting for this channel
            amqpChannel.on('error', () => {});
            try { Promise.resolve(amqpChannel.close()).catch(() => {}); } catch (e) {}   // closed
            throw new Error('channel closed while it was being created');
          }
          let old_id = this._id;
          this._id = this.#createID();
          this.emit('info', {message: `Channel created`, id: this._id, old_id})
          this.amqpChannel = amqpChannel;
          // a replaced amqplib channel can still close or error late; only the current one counts
          this.amqpChannel.on('close', () => {
            if (amqpChannel !== this.amqpChannel) return;
            this.alive = false;
            this.emit('close')
          });
          this.amqpChannel.on('error', (err) => {
            if (amqpChannel !== this.amqpChannel) return;
            this.alive = false;
            this.emit('error', err);
          });

          if (this.prefetch) {
            return this.amqpChannel.prefetch(this.prefetch);
          }

          return amqpChannel;
        })
      }
      else {
        this.emit('error', { message: 'my connection is dead!!!'})
        throw new Error('my connection is dead!!!')
      }
  }
  create() {
    if (this.#closed) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    let created = false;
    this.#createChannel()
    .then(() => {
          if (this?.exchange?.name && this?.exchange?.type) {
            return this.amqpChannel.assertExchange(this.exchange.name, this.exchange.type, this.exchangeOptions).catch( error => {
              if(error.code === 406 && error.classId === 40){
                this.emit('info', {message: `Durable Escape for connect`})
                return this.#createChannel();
              }
              this.emit('error', {message: 'cant assert a exchange ' + error?.message, err: error})
            });
          }
          if (this?.exchange?.name) {
            return this.amqpChannel.checkExchange(this.exchange.name);
          }
          return true;
        })
        .then(() => {
          if(this.isConsumable){
            return this.#createQueue(this.queue.name, this.queueOptions)
          }
          return true;
        })
        .then(() => {
          if (this?.binding?.enabled && this?.queue?.name && this?.exchange?.name) {
            return this.#bindQueue(this.queue.name, this.exchange.name, this?.binding?.pattern || '', this?.binding?.options || {});
          }
          return true;
        })
        .then(() => {
          created = true;
          return true;
        })
        .catch((err) => {
          if (this.#closed) return;   // its create was cut short by the close: no error to report
          this.emit('error', {message: 'cant establish a channel', err: err});
          this.emit('info', {message: 'channel create failed', channelId: this._id, queue: this.queue?.name, exchange: this.exchange?.name, error: err?.message});
          this.alive = false;
          return this.connection
        }).finally( _ => {
          this.#isConnecting = false;
          clearTimeout(this.#retryTimer);
          this.#retryTimer = null;
          // close() closed the amqplib channel; no 'ready', and no retry (create() would refuse it)
          if (this.#closed) return;
          if (!created) {
            try { this.amqpChannel?.close()?.catch?.(() => {}); } catch (e) {}   // already closed
            // retry while the connection is up; a dead connection re-creates its channels on reconnect.
            // The wait doubles per consecutive failure, from reconnectInterval up to channelRetryMaxInterval.
            if (this.connection.alive) {
              const max = this.connection.config?.channelRetryMaxInterval || 30000;
              const delay = Math.min(this.#retryDelay || this.connection.reconnectInterval || 1500, max);
              this.#retryDelay = Math.min(delay * 2, max);
              this.#retryTimer = setTimeout(() => {
                this.#retryTimer = null;
                if (this.connection.alive) this.create();
              }, delay);
              this.#retryTimer.unref?.();
            }
            return;
          }
          this.#retryDelay = 0;
          this.alive = true;
          this.emit('info', {message: 'channel created', id: this._id})
          // 'ready' fires once per Channel; a re-create emits 'recreated' so 'ready' listeners
          // that attach 'message' handlers do not stack up
          const event = this.#readyEmitted ? 'recreated' : 'ready';
          this.#readyEmitted = true;
          this.emit(event, this);
          // a channel that was consuming resumes on the new amqplib channel
          if(this.autoConsume || this.#consumingOn) this.consume()
        });
  }
  #createQueue(queue, options){
      return this.amqpChannel.checkQueue(queue).then(assertion => {
          if(assertion.queue){
            this.queue.name = assertion.queue;
            return true;
          }

        }).catch(err => {
            if(err.code === 404){
                return this.#createChannel()
                  .then(_ => this.amqpChannel.assertQueue(queue, options))
                  .then((assertion) => {
                    this.emit('info', `queue ${assertion.queue} created`)
                    return true;
                  });
            }
            this.emit('error',err)
            throw err;
        })
  }
  #bindQueue(queue, exchange, pattern = '', options = {}){
    if(Array.isArray(options)){
      options.forEach( header => {
        this.amqpChannel.bindQueue(queue, exchange, pattern, header);
      })
      return true;
    }else {
      return this.amqpChannel.bindQueue(queue, exchange, pattern, options);
    }
  } 
  publish(msg, topic = this.topic, options = this.options) {
    if (msg) {
      if(msg instanceof Object){
        Object.assign(msg, this.msg);
        msg = JSON.stringify(msg)
      }
      // the channel's own defaults are copied, so ids and timestamps are not kept on them
      if(options === this.options) options = { ...options };
      options.messageId = options?.messageId || uuid();
      options.messageId = options?.messageId || nanoId();
      options.timestamp = options?.timestamp || Math.round(new Date().getTime()/1000);
      if (this.alive) {
        let message = Buffer.from(msg);
        const exchange = options.exchange || this.exchange.name;
        const named = this.#exchangeName(options);
        try {
          publishing(this.connection.url, named, options, withContext =>
            this.amqpChannel.publish(exchange, topic || "", message, withContext));
        } catch (error) {
          countSent(this.connection.url, named, thrownType(error));
          throw error;
        }
        this.emit("info", { message: 'message published', options: options, exchange: options.exchange || this.exchange, url: this.connection.safeUrl})
        countSent(this.connection.url, named);
      } else {
        countSent(this.connection.url, this.#exchangeName(options), 'channel_dead');
        this.emit('error', {message: 'channel is dead!', channelId: this._id, queue: this.queue?.name, exchange: this.exchange?.name})
        throw new Error('Channel is dead!')
      }
    }
  }
  consume(queue = this.queue.name) {
    if (this.alive) {
      if(!this.isConsumable){
        this.emit('info', {message: 'consume queue name is missing creating dynamic queue' })
        this.#temporaryQueue = true;
        // it names the queue itself, so it declares it directly: a passive check of a new name
        // gets a 404 that closes the channel, and the consume would find the channel dead
        this.amqpChannel.assertQueue(`${this._id}:${os.hostname}`, this.queueOptions).then( asserted => {
          const name = asserted?.queue;
          if(!name){
            this.emit('error', {message: 'dynamic queue has no name', channelId: this._id})
            return;
          }
          this.queue.name = name
          this.emit('info', `Queue created dynamic: ${this.queue.name}`)
          // returned, so a refused bind reaches the catch below as an error event
          return Promise.resolve(this.#bindQueue(this.queue.name, this.exchange.name, this?.binding?.pattern || '', this?.binding?.options || {})).then( () => {
            this.emit('info', {message: `consume from queue: ${this.queue.name}`})
            this.consume();
          });
        }).catch(e => {
          this.emit('error', e)
        })
      }else {
        // already consuming here: the same consumerTag twice would make the broker close the channel
        if (this.#consumingOn === this.amqpChannel) return;
        const amqpChannel = this.#consumingOn = this.amqpChannel;
        this.emit('info', {message: `consume started on queue: ${queue}`})
        this.amqpChannel.consume(this.queue.name, (m) => {
          if (m == null) {
            this.amqpChannel.close();
            this.create();
            this.emit('error', {message: 'Message is null', channelId: this._id, queue: this.queue?.name, exchange: this.exchange?.name})
          } else {
            deliveredOn.set(m, amqpChannel);
            m.properties.channelId = this._id;
            if(!m.properties.messageId) m.properties.messageId = uuid();
            if(!m.properties.timestamp) m.properties.timestamp = Math.round(new Date().getTime()/1000);
            m.properties.queue = this.queue.name;
            
            countConsumed(this.connection.url, this.#destination);
            processing(this.connection.url, this.#destination, m, () => {
              this.emit('message', m);
              this.emit('channelMessage', m)
            });
          }
        }, {consumerTag: this._id}).catch(err => {
          this.emit('error', {message: 'consume failed', channelId: this._id, queue: this.queue?.name, error: err?.message});
        });
      }
    } else {
      this.emit('error', {message: 'channel is dead!', channelId: this._id, queue: this.queue?.name, exchange: this.exchange?.name})
    }
  }

  ack(msg) {
    if (msg) {
      let messageId = msg?.properties?.messageId || msg?.messageId;
      let timestamp = msg?.properties?.timestamp || msg?.timestamp;
      let deliveryTag = msg?.fields?.deliveryTag;
      if(!this.alive){
        this.emit('error', {message: 'channel is dead!', channelId: this._id, queue: this.queue?.name, exchange: this.exchange?.name});
      }
      else if(this.#isStale(msg, 'ack')) return;
      else if(deliveryTag){
        this.amqpChannel.ack(msg);
        countSettled(this.connection.url, 'ack', this.#destination);
      }else {
        this.emit('error', {message: `DELIVERY TAG NOT FOUND ${messageId}`, channelId: this._id, queue: this.queue?.name, exchange: this.exchange?.name, messageId});
      }
    }
  }

  nack(msg) {
    if (msg) {

      let deliveryTag = msg?.fields?.deliveryTag;

      if (this.alive && deliveryTag && !this.#isStale(msg, 'nack')) {
        this.amqpChannel.nack(msg);
        countSettled(this.connection.url, 'nack', this.#destination);
      }
    }
  }

  // The message came on an amqplib channel that has since been replaced. Its delivery tag is
  // unknown on the current one (RabbitMQ would close it with 406 PRECONDITION_FAILED), and the
  // broker already requeued the message when the old channel closed, so the ack is dropped.
  #isStale(msg, op) {
    const from = deliveredOn.get(msg);
    if (!from || from === this.amqpChannel) return false;
    this.emit('info', {
      message: `stale ${op} dropped`,
      messageId: msg.properties?.messageId,
      channelId: msg.properties?.channelId,
      reason: 'delivered on a previous channel, the broker requeued it'
    });
    return true;
  }

  hasCachedAck() {
    return this._cacheAck.length > 0;
  }

  sendToQueue(queue, msg) {
    if(msg instanceof Object){
      Object.assign(msg, this.msg);
      msg = JSON.stringify(msg)
    }
    msg = Buffer.from(msg)
    // the default exchange has no name; telemetry names it amq.default
    try {
      publishing(this.connection.url, undefined, undefined, () =>
        this.amqpChannel.sendToQueue(queue, msg));
    } catch (error) {
      countSent(this.connection.url, undefined, thrownType(error));
      throw error;
    }
    countSent(this.connection.url, undefined);
  }
}
module.exports = Channel;