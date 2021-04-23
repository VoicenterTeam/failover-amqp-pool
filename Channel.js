const EventEmitter = require('events').EventEmitter;

class Channel extends EventEmitter {
  constructor(connection, channelConfig) {
    super();

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
    this._cacheMsg = [];
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

    this.connection.on('connection', () => {
      this.create();
    })
  }

  create() {
    if (this.connection.alive) {
      this.connection.amqpConnection.createConfirmChannel()
        .then((amqpChannel) => {
          this.amqpChannel = amqpChannel;
          this.alive = true;
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
          return true;
        })
        .then(() => {
          if (!!~this.directives.indexOf('aq')) {
            return this.amqpChannel.assertQueue(this.queue, {exclusive: false, durable: true, noAck: !this.prefetch})
              .then((assertion) => {
                this.queue = assertion.queue;
                return true;
              });
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
          this.republish();
          this.reack();
          this.removeAllListeners('message');
          this.emit('ready', this);
          return true;
        })
        .catch((err) => {
          this.alive = false;
          setTimeout(() => {
            this.create();
          }, 500);
        });
    } else {
      console.log("Whoops my connection is dead!!!");
    }
  }

  publish(msg) {
    if (msg) {
      this._cacheMsg.push(msg);
      if (this.alive) {
        if (this.hasCachedMsg()) {
          let message = Buffer.from(this._cacheMsg[0]);
          this.amqpChannel.publish(this.exchange, this.topic || '', message, this.options || {}, (a) => {
            this._cacheMsg.splice(this._cacheMsg.indexOf(this._cacheMsg[0]),1);
            this.republish();
          });
        }
      } else {
        this.emit('failover', this._cacheMsg.shift());
        console.log("Channel is dead!");
      }
    }
  }

  republish() {
    if (this.hasCachedMsg()) {
      this.publish(this._cacheMsg.pop());
    }
  }

  hasCachedMsg() {
    return this._cacheMsg.length > 0;
  }

  consume() {
    if (this.alive) {
      this.amqpChannel.consume(this.queue, (m) => {
        if (m == null) {
          this.amqpChannel.close();
          this.create();
          console.log("Message is null");
        } else {
          this.emit('message', m);
        }
      });
    } else {
      console.log("Channel is dead!");
      setTimeout(() => {
        this.consume();
      }, 500);
    }
  }

  ack(msg) {
    if (msg) {
      this._cacheAck.push(msg);
      if (this.alive) {
        if (this.hasCachedAck()) {
          let a = this.amqpChannel.ack(this._cacheAck.shift());
          this.reack();
        }
      } else {
        setTimeout(() => {
          this.consume();
        }, 500);
      }
    }
  }

  reack() {
    if (this.hasCachedAck()) {
      this.ack(this._cacheAck.pop());
    }
  }

  hasCachedAck() {
    return this._cacheAck.length > 0;
  }

  sendToQueue(msg) {

  }
}

module.exports = Channel;