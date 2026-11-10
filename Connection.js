const amqplib = require('amqplib');
const EventEmitter = require('events').EventEmitter;
const os = require('os');
const { countConnectionError, countReconnect } = require('./telemetry/metrics');


class Connection extends EventEmitter {
  #isAlive = false;
  constructor(url, config) {
    super();
    this.url = url;
    this.URL = new URL(this.url)
    // the URL for emitted events: no username or password
    this.safeUrl = Object.assign(new URL(this.url), {username: '', password: ''}).toString()
    this.config = config;
    this.channels = [];
    this.amqpConnection = null;
    this.alive = false;
    this.reconnectInterval = this.config.reconnectInterval  || 1500
    this.timeout = this.config?.timeout || 5000
    this.connection_name = (this.config?.connection_name || 'amqp_pool_client') + `_${os.hostname}`
    this.reconnectOnClose = true;
  }
  set alive(isAlive) {
    this.#isAlive = isAlive;
      if(!this.#isAlive) 
        this.channels.forEach( channel => {
            channel.alive = this.#isAlive;
        })
  }
  get alive(){
    return this.#isAlive
  }

  start() {
    if (!this.alive) {
      this.emit('info', { message: 'Connecting', url: this.safeUrl})
      amqplib.connect(this.url, {timeout: this.timeout ,clientProperties: {connection_name: this.connection_name}})
      .then((connection) => {
          this.amqpConnection = connection;
          this.amqpConnection.on('close', (e) => {
            this.alive = false;
            let timeOutReconnect = setTimeout(() => {
                clearTimeout(timeOutReconnect)
                if(this.reconnectOnClose) {
                  countReconnect(this.url);
                  this.start();
                }
            }, this.reconnectInterval);

            this.emit('close', { msg: "connection closed", url: this.safeUrl});
          });
          this.amqpConnection.on('error', (error) => {
            countConnectionError(this.url, error);
            this.emit('error', { error: error , url: this.safeUrl})
          });
          this.alive = true;
          this.emit('info', {message: 'Connection created', url: this.safeUrl});
          this.connection()
        })
        .then(() => {
          //this.emit('connection', this);
          //console.log('Ok');
        })
        .catch((error) => {
          this.alive = false;
          countConnectionError(this.url, error);
          this.emit('error', { error: error , url: this.safeUrl})
          let timeout = setTimeout(() => {
            clearTimeout(timeout);
            countReconnect(this.url);
            this.start();
          }, this.reconnectInterval);
        });
    }
  }
  connection(){
    this.channels.forEach( channel => {
      try {
        channel.create()
      } catch (error) {
          this.emit('error', { error: error , url: this.safeUrl})
      }
      
    })
  }
  addChannel(channel) {
    this.channels.push(channel);
  }

  removeChannel(channel) {
    if (!!~this.channels.indexOf(channel)) {
      this.channels.splice(this.channels.indexOf(channel), 1);
    }
  }

  disconnect() {
    this.alive = false;
    this.reconnectOnClose = false;
    if (this.amqpConnection) {
      this.amqpConnection.close();
      this.amqpConnection = undefined;
      this.channels = [];
    }
  }

}

module.exports = Connection;