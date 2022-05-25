const amqplib = require('amqplib');
const EventEmitter = require('events').EventEmitter;

class AmqpPool extends EventEmitter {
  constructor(config) {
    super();

    this.configPool = [];
    this.msgPool = [];
    this.currentConfigIndex = 0;
    this.currentConfig = null;
    this.currentConnection = false;
    this.currentChannel = false;
    this.dynamicQueue = {};

    if (config instanceof Array) {
      this.configPool = config;
    } else {
      this.configPool = [config];
    }
  }

  connect() {
    setTimeout(() => {
      if (this.configPool.length > 0) {
        let config = this._getCurrentConfig();
        if (config && config.hasOwnProperty('connection')) {
          return this._startConnection()
            .then(this._startChannel.bind(this))
            .then(this._configChannel.bind(this))
            .then(this._reconfigureDynamicQueue.bind(this))
            .catch(this._handleError.bind(this));
        }
      }
      // this._tryRecover();
    }, 1000);
  }

  close() {
    return this.currentConnection.close();
  }

  consume(_r = false) {
    if (this.currentChannel) {
      if (!_r) {
        this.removeAllListeners('message');
      }
      let config = this._getCurrentConfig();
      this.currentChannel.consume(config.channel.queue_name, (m) => {
        if (m == null) {
          this.consume(1);
        } else {
          this.emit('message', m);
        }
      });
    }
  }

  publish(message = null) {
    console.log(this.msgPool);
    message = message||this.msgPool.shift();
    if (message) {
      let config = this._getCurrentConfig();
      if (config.channel.hasOwnProperty('exchange_name')) {
        if (this.currentChannel) {
          let msg = Buffer.from(message);
          this.currentChannel.publish(config.channel.exchange_name, config.channel.topic || '', msg, config.channel.options || {});
          this.publish();
        }  else {
          this.msgPool.push(message);
        }
      }
    }
  }

  sendToQueue(message) {
    if (this.currentChannel) {
      let config = this._getCurrentConfig();
      let msg = Buffer.from(message);
      if (config.channel.hasOwnProperty('queue_name')) {
        this.currentChannel.sendToQueue(config.channel.queue_name, msg);
      }
    }
  }

  ack(m) {
    if (this.currentChannel) {
      this.currentChannel.ack(m);
    }
  }

  nack(m) {
    if (this.currentChannel) {
      this.currentChannel.nack(m);
    }
  }

  async createDynamicQueue(exchange,queue,headersList){
    console.log('createDynamicQueue',exchange,queue,headersList);
    try {
      await this.currentChannel.deleteQueue(queue);
    }catch (e) {
      console.log("before createQueue deleteQueue was failed ,probbely fist time to be decleare ",e);
    }
    try {
      await this.currentChannel.assertQueue(queue || '', {exclusive: false, durable:  !this.currentConfig.channel.durable, noAck: !this.currentConfig.channel.prefetch});
      this.currentChannel.consume(queue || '', (m) => {
        if (m == null) {
          this.consume(1);
        } else {
          m.queue=queue;
          this.emit('message', m);
        }
      });
    }catch (e) {
      console.error("faild to create queue ",queue, "Error is ",e);
      return;
    }
    if(!headersList)headersList=[null];
    if(headersList.constructor.name==="Object")headersList=[headersList];
    for (const headers of  headersList){
      try {
        await this.currentChannel.bindQueue(queue, exchange||this.currentConfig.channel.exchange_name,'',headers)
      }catch (e) {
        console.error("faild to bindQueue ",queue,headers, "Error is ",e);
      }
    }
    this.dynamicQueue[queue]={exchange,queue,headersList};
  }

  _tryRecover() {
    this._rotateConfig();
    this.connect();
  }

  _getCurrentConfig() {
    if (!this.currentConfig) {
      this.currentConfig = this.configPool[this.currentConfigIndex];
    }
    return this.currentConfig;
  }

  _rotateConfig() {
    this.currentConfigIndex++;
    if (this.configPool.length > 0) {
      if (this.currentConfigIndex >= this.configPool.length) {
        this.currentConfigIndex = 0;
      }
      this.currentConfig = this.configPool[this.currentConfigIndex];
      return this.currentConfigIndex;
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
          this._tryRecover();
        });
        this.currentConnection = connection;
        return connection;
      });
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
        });
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
        this.publish();
        this.emit('channel', this);
        return channel;
      });
  }

 async _reconfigureDynamicQueue(){
    try {
      for (const [queue, bindConfig] of Object.entries(this.dynamicQueue)) {
        await this.createDynamicQueue(bindConfig.exchange,queue,bindConfig.headersList);
      }
    }catch (error){
      console.error("faild to reconfigure DynamicQueue",error);
    }
  }
  
  _handleError(e) {
    console.log(JSON.stringify(e));
    this._tryRecover();
  }
}

module.exports = AmqpPool;
