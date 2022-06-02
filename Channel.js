const EventEmitter = require('events').EventEmitter,
      nanoId = require('nanoid');

class Channel extends EventEmitter {
  constructor(connection, channelConfig) {
    super();

    this._id = nanoId();
    this.connection = connection;
    this.amqpChannel = null;
    this.directives = ["ea", "qa"];
    this.exchange = "";
    this.exchange_type = "";
    this.queue = "";
    this.prefetch = false;
    this.topic = "";
    this.options = {};
    this.alive = false;
    // this._cacheMsg = [];
    this._cacheAck = [];

    if (channelConfig.hasOwnProperty('directives')) {
      this.directives = channelConfig.hasOwnProperty('directives') && channelConfig.directives.split(',').length > 0 ? channelConfig.directives.split(',') : ["ea", "qa"];
    }
    if (channelConfig.hasOwnProperty('exchange_name')) {
      this.exchange = channelConfig.exchange_name;
    }
    if (channelConfig.hasOwnProperty('exchange_type')) {
      this.exchange_type = channelConfig.exchange_type;
    }
    if (channelConfig.hasOwnProperty('queue_name')) {
      this.queue = channelConfig.queue_name;
    }
    if (channelConfig.hasOwnProperty('prefetch')) {
      this.prefetch = !isNaN(parseInt(channelConfig.prefetch)) ? parseInt(channelConfig.prefetch) : false;
    }
    if (channelConfig.hasOwnProperty('topic')) {
      this.topic = channelConfig.topic;
    }
    if (channelConfig.hasOwnProperty('options')) {
      this.options = channelConfig.options;
    }

    this.options.mandatory = true;

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
            // setTimeout(() => {
            //   console.log("Channel retry");
            //   this.create();
            // }, 1000);
          });

          if (this.prefetch) {
            return this.amqpChannel.prefetch(this.prefetch);
          }

          return amqpChannel;
        })
        .then(() => {
          if (!!~this.directives.indexOf('ae') && this.exchange !== "") {
            return this.amqpChannel.assertExchange(this.exchange, this.exchange_type, {durable: true});
          }
          if (this.hasOwnProperty('exchange') && this.exchange !== '') {
            return this.amqpChannel.checkExchange(this.exchange);
          }
          return true;
        })
        .then(() => {
          if (!!~this.directives.indexOf('aq')) {
            let opts = {
              exclusive: false,
              durable: true,
              noAck: !this.prefetch,
              expires: this?.options?.expires,
              messageTtl: this?.options?.messageTtl,
              deadLetterExchange: this?.options?.deadLetterExchange,
              deadLetterRoutingKey: this?.options?.deadLetterRoutingKey,
              maxLength: this?.options?.maxLength,
              maxPriority: this?.options?.maxPriority,
              overflow: this?.options?.overflow,
              queueMode: this?.options?.queueMode,
            };
            return this.amqpChannel.assertQueue(this.queue, opts)
              .then((assertion) => {
                this.queue = assertion.queue;
                return true;
              });
          }
          if (this.hasOwnProperty('queue') && this.queue !== '') {
            return this.amqpChannel.checkQueue(this.queue);
          }
          return true;
        })
        .then(() => {
          if (!!~this.directives.indexOf('qte') && this.queue !== "" && this.exchange !== "") {
            return this.amqpChannel.bindQueue(this.queue, this.exchange, this.topic || '', this.options || {});
          }
          return true;
        })
        .then(() => {
          // this.republish();
          // this.reack();
          this.removeAllListeners('message');
          this.alive = true;
          this.emit('ready', this);
          return true;
        })
        .catch((err) => {
          console.log(err);
          console.log("err");
          this.alive = false;
          // setTimeout(() => {
          //   this.create();
          // }, 500);
        });
    } else {
      console.log("Whoops my connection is dead!!!");
    }
  }

  publish(msg, topic = null, options = null) {
    if (msg) {
      if (this.alive) {
        let message = Buffer.from(msg);
        this.amqpChannel.publish(this.exchange, topic || this.topic, message, options || this.options, () => {});
      } else {
        throw new Error('Channel is dead!')
        console.log("Channel is dead!");
      }
    }
  }

  // republish() {
  //   if (this.hasCachedMsg()) {
  //     this.publish(this._cacheMsg.pop());
  //   }
  // }

  // hasCachedMsg() {
  //   return this._cacheMsg.length > 0;
  // }

  consume() {
    if (this.alive) {
      this.amqpChannel.consume(this.queue, (m) => {
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

  hasCachedAck() {
    return this._cacheAck.length > 0;
  }

  sendToQueue(msg) {

  }
}

module.exports = Channel;