const amqplib = require('amqplib');
const EventEmitter = require('events').EventEmitter;

class AmqpPool extends EventEmitter {
  pool = [];
  currentIndex = 0;
  currentConfig = null;
  currentConnection = false;
  currentChannel = false;

  constructor(config) {
    super();
    if (config instanceof Array) {
      this.pool = config;
    } else {
      this.pool = [config];
    }
  }

  connect() {
    setTimeout(() => {
      if (this.pool.length > 0) {
        let config = this._getCurrentConfig();
        if (config && config.hasOwnProperty('connection')) {
          return this._startConnection()
            .then(this._startChannel.bind(this))
            .then(this._configChannel.bind(this))
            .catch(this._handleError.bind(this));
        }
      }
      // this._tryRecover();
    }, 1000);
  }

  close() {
    return this.currentConnection.close();
  }

  consume() {
    if (this.currentChannel) {
      this.removeAllListeners('message');
      let config = this._getCurrentConfig();
      this.currentChannel.consume(config.channel.queue_name, (m) => {
        this.emit('message', m);
      });
    }
  }

  publish(message) {
    if (this.currentChannel) {
      let config = this._getCurrentConfig();
      let msg = Buffer.from(message);
      if (config.channel.hasOwnProperty('queue_name')) {
        this.currentChannel.sendToQueue(config.channel.queue_name, msg);
      } else if (config.channel.hasOwnProperty('exchange_name')) {
        this.currentChannel.publish(config.channel.exchange_name, config.channel.topic || '', msg, config.channel.options || {});
      }
    }
  }

  ack(m) {
    this.currentChannel.ack(m);
  }

  nack(m) {
    this.currentChannel.nack(m);
  }

  _tryRecover() {
    this._rotateConfig();
    this.connect();
  }

  _getCurrentConfig() {
    if (!this.currentConfig) {
      this.currentConfig = this.pool[this.currentIndex];
    }
    return this.currentConfig;
  }

  _rotateConfig() {
    this.currentIndex++;
    if (this.pool.length > 0) {
      if (this.currentIndex >= this.pool.length) {
        this.currentIndex = 0;
      }
      this.currentConfig = this.pool[this.currentIndex];
      return this.currentIndex;
    }
    else {
      return false;
    }
  }

  _buildUrl(config) {
    let url = (config.ssl ? 'amqps' : 'amqp') + '://';
    if (config.username && config.password) {
      url += config.username + ':' + config.password + '@';
    }
    url += config.host + ':' + config.port;
    if (config.vhost) {
      url += config.vhost;
    }
    if(config.hasOwnProperty('heartbeat')) {
      url += '?heartbeat=' + config.heartbeat;
    }
    return url;
  }

  _startConnection() {
    let config = this._getCurrentConfig();
    let url = this._buildUrl(config.connection);
    return amqplib.connect(url, {})
      .then((connection) => {
        connection.on('error', (e) => {
          console.log("Connection Error");
          console.log(e);
        });
        connection.on('close', () => {
          console.log('Close Connection');
          this.currentConnection = false;
          this.currentChannel = false;
          // this._tryRecover();
        });
        this.currentConnection = connection;
        return connection;
      })
  }

  _startChannel(connection) {

    if (!connection) {
      return Promise.reject('No connection');
    }

    return connection.createConfirmChannel()
      .then((channel) => {
        channel.on('error', (e) => {
          console.log("Channel Error");
          console.log(e);
        })
        channel.on('close', () => {
          console.log("Channel Close");
          this.close();
        });
        return channel;
      })
      .then((channel) => {
        this.currentChannel = channel;
        return channel;
      });
  }

  _configChannel(channel) {

    if (!channel) {
      return Promise.reject('No channel');
    }

    return Promise.resolve(channel)
      .then((channel) => {
        let config = this._getCurrentConfig();
        if (config.channel.hasOwnProperty('exchange_name')) {
          return channel.assertExchange(config.channel.exchange_name, config.channel.exchange_type, {durable: true})
            .then(() => {
              return channel;
            });
        }
        return channel;
      })
      .then((channel) => {
        let config = this._getCurrentConfig();
        if (config.channel.queue_name !== false) {
          return channel.assertQueue(config.channel.queue_name || '', {exclusive: false, durable: true, noAck: !config.channel.prefetch})
            .then((assertion) => {
              if (config.channel.hasOwnProperty('exchange_name')) {
                return channel.bindQueue(assertion.queue, config.channel.exchange_name, config.channel.topic || '', config.channel.options || {})
                  .then(() => {
                    this.currentConfig.channel.queue_name = assertion.queue;
                    return channel;
                  });
              }
              return channel;
            });
        }
        return channel;
      })
      .then((channel) => {
        let config = this._getCurrentConfig();
        if (!isNaN(parseInt(config.channel.prefetch)) && config.channel.prefetch > 0) {
          channel.prefetch(config.channel.prefetch);
        }
        return channel;
      })
      .then((channel) => {
        console.log('emit channel');
        this.emit('channel', this);
        return channel;
      });
  }

  _handleError(e) {
    console.log(JSON.stringify(e));
    this._tryRecover();
  }
}

module.exports = AmqpPool;