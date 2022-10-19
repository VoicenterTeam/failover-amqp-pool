const EventEmitter = require('events').EventEmitter,
      nanoId = require('nanoid');

class Channel extends EventEmitter {
  constructor(connection, channelConfig) {
    super();

    this._id = nanoId();
    this.connection = connection;
    this.amqpChannel = null;
    this.directives = ["ea", "qa"];
    this.exchange = channelConfig?.exchange;
    this.binding = channelConfig?.binding;
    this.queue = channelConfig?.queue;
    this.prefetch = false;
    this.topic = channelConfig?.topic || "";
    this.options = channelConfig?.options || {};
    this.alive = false;
    this.msg = channelConfig.msg
    this._cacheAck = [];

    if (channelConfig.hasOwnProperty('prefetch')  && channelConfig.prefetch) {
      this.prefetch = !isNaN(parseInt(channelConfig.prefetch)) ? parseInt(channelConfig.prefetch) : false;
    }

    this.connection.on('connection', () => {
      this.create();
    })
  }

  create() {
    if (this.connection.alive) {
      this.connection.amqpConnection.createConfirmChannel()
        .then((amqpChannel) => {
          amqpChannel.waitForConfirms();
          this.amqpChannel = amqpChannel;
          this.amqpChannel.on('close', () => {
            this.alive = false;
            console.log('Channel closes');
            setTimeout(() => {
              console.log("Channel retry");
              this.create();
            }, 500);
          });
          this.amqpChannel.on('error', (e) => {
            this.alive = false;
            console.log(e);
            console.log('Channel error');
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
          if (this?.queue?.name) {
            let opts = {
              exclusive: this?.queue?.options?.exclusive || false,
              durable: this?.queue?.options?.durable || true,
              arguments: this?.queue?.options?.arguments || {},
              noAck: !this.prefetch,
              expires: this?.queue?.options?.expires,
              messageTtl: this?.queue?.options?.messageTtl,
              deadLetterExchange: this?.queue?.options?.deadLetterExchange,
              deadLetterRoutingKey: this?.queue?.options?.deadLetterRoutingKey,
              maxLength: this?.queue?.options?.maxLength,
              maxPriority: this?.queue?.options?.maxPriority,
              overflow: this?.queue?.options?.overflow,
              queueMode: this?.queue?.options?.queueMode,
              autoDelete: this?.queue?.options?.autoDelete,
              consumerTag: this?.queue?.options?.consumerTag,
              noLocal: this?.queue?.options?.noLocal
            };
            return this.amqpChannel.assertQueue(this.queue.name, opts)
              .then((assertion) => {
                this.queue.name = assertion.queue;
                return true;
              });
          }
          if (this?.queue?.name) {
            return this.amqpChannel.checkQueue(this.queue.name);
          }
          return true;
        })
        .then(() => {
          if (this?.binding?.enabled && this?.queue?.name && this?.exchange?.name) {
            return this.amqpChannel.bindQueue(this.queue.name, this.exchange.name, this?.binding?.pattern || '', this?.binding?.options || {});
          }
          return true;
        })
        .then(() => {
          this.removeAllListeners('message');
          this.alive = true;
          this.emit('ready', this);
          return true;
        })
        .catch((err) => {
          console.log(err);
          console.log("err");
          this.alive = false;
        });
    } else {
      console.log("Whoops my connection is dead!!!");
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
      } else {
        throw new Error('Channel is dead!')
        console.log("Channel is dead!");
      }
    }
  }

  consume() {
    if (this.alive) {
      this.amqpChannel.consume(this.queue.name, (m) => {
        if (m == null) {
          this.amqpChannel.close();
          this.create();
          console.log("Message is null");
        } else {
          m.properties.channelId = this._id;
          this.emit('message', m);
        }
      });
    } else {
      console.log("Channel is dead!");
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

  sendToQueue(msg) {

  }
}

module.exports = Channel;