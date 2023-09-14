const EventEmitter = require('events').EventEmitter,
      nanoId = require('nanoid'),
      hash = require('object-hash'),
      os = require('os');
class Channel extends EventEmitter {
  #isAlive= false;
  #isConnecting = false;
  constructor(connection, channelConfig) {
    super();
    this.hash = hash(channelConfig)
    this._id = nanoId();
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
  get isConsumable(){
    return this.queue && this.queue.name
  }
  get alive(){
    if(!this.#isAlive && !this.#isConnecting)
      this.create();
    return this.#isAlive;
  }
  set alive(isAlive){
    this.#isAlive = isAlive;
  }
  get queueOptions(){
    let messageTtl = 3600000;
    if(this?.queue?.options?.messageTtl === 'none') messageTtl = undefined
    if(Number.isInteger(this?.queue?.options?.messageTtl)) messageTtl = this?.queue?.options?.messageTtl

    return {
      exclusive: this?.queue?.options?.exclusive || false,
      durable: this?.queue?.options?.durable || false,
      arguments: this?.queue?.options?.arguments || {},
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
  create() {
    if (this.connection.alive) {
      this.#isConnecting = true;
      this.connection.amqpConnection.createConfirmChannel()
        .then((amqpChannel) => {
          this.amqpChannel = amqpChannel;
          this.amqpChannel.on('close', () => {
            this.alive = false;
          });
          this.amqpChannel.on('error', (err) => {
            this.alive = false;
            this.emit('error', err);
          });

          if (this.prefetch) {
            return this.amqpChannel.prefetch(this.prefetch);
          }

          return amqpChannel;
        })
        .then(() => {
          if (this?.exchange?.name && this?.exchange?.type) {
            return this.amqpChannel.assertExchange(this.exchange.name, this.exchange.type, this.exchange.options || {});
          }
          if (this?.exchange?.name) {
            return this.amqpChannel.checkExchange(this.exchange.name);
          }
          return true;
        })
        .then(() => {
          if (this.isConsumable) {
            if (!this.queueStatus)
            return this.amqpChannel.checkQueue(this.queue.name).catch(err => {
              if(err.code === 404){
                  this.queueStatus = 1;
                  this.create();
              }
               this.emit('error',err)
            })
          }
          return true;
        }).then((assertion) =>{
          if(assertion.queue){
            this.queue.name = assertion.queue;
            return true;
          }
          return this.amqpChannel.assertQueue(this.queue.name, this.queueOptions)
          .then((assertion) => {
            this.queue.name = assertion.queue;
            return true;
          });
        })
        .then(() => {
          if (this?.binding?.enabled && this?.queue?.name && this?.exchange?.name) {
            return this.#bindQueue(this.queue.name, this.exchange.name, this?.binding?.pattern || '', this?.binding?.options || {});
          }
          return true;
        })
        .then(() => {
          this.removeAllListeners('message');
          this.alive = true;
          this.emit('info', {message: 'channel created', id: this._id})
          this.emit('ready', this);
          if(this.autoConsume) this.consume()
          return true;
        })
        .catch((err) => {
          this.emit('error', {message: 'cant establish a channel', err: err});
          this.alive = false;
          return this.connection
        }).finally( _ => {
          this.#isConnecting = false;
        });
    } else {
      this.emit('error', { message: 'my connection is dead!!!'})
    }
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
      options.messageId = options?.messageId || nanoId();
      options.timestamp = options?.timestamp || Math.round(new Date().getTime()/1000);
      if (this.alive) {
        let message = Buffer.from(msg);
        this.amqpChannel.publish(this.exchange.name, topic || "", message, options)
        this.emit("info", { message: 'message published', options: options, exchange: this.exchange, url: this.connection.url})
      } else {
        this.emit('error', {message: 'channel is dead!', channel: this})
        throw new Error('Channel is dead!')
      }
    }
  }
  consume(queue = this.queue.name) {
    if (this.alive) {
      if(!this.isConsumable){
        this.emit('info', {message: 'consume queue name is missing creating dynamic queue' })

        this.amqpChannel.assertQueue(`${this._id}:${os.hostname}` , this.queueOptions).then( m => {
          this.queue.name = m.queue 
          this.emit('info', `Queue created dynamic: ${this.queue.name}`)
          this.#bindQueue(this.queue.name, this.exchange.name, this?.binding?.pattern || '', this?.binding?.options || {}).then( b => {
            this.consume();
          });

          
        }).catch(e => {
          console.log(e)
        })
      }else {
        this.amqpChannel.consume(this.queue.name, (m) => {
          if (m == null) {
            this.amqpChannel.close();
            this.create();
            this.emit('error', {message: 'Message is null', channel: this, m: m})
          } else {
            m.properties.channelId = this._id;
            m.properties.queue = queue
            this.emit('message', m);
            this.emit('channelMessage', m)
          }
        });
      }
    } else {
      this.emit('error', {message: 'channel is dead!', channel: this})
    }
  }

  ack(msg) {
    if (msg) {
      if (this.alive) {
        this.amqpChannel.ack(msg);
      }
    }
  }

  nack(msg) {
    if (msg) {
      if (this.alive) {
        this.amqpChannel.nack(msg);
      }
    }
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
    this.amqpChannel.sendToQueue(queue, message)
  }
}

module.exports = Channel;