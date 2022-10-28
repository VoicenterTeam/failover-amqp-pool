const amqplib = require('amqplib');
const EventEmitter = require('events').EventEmitter;

class Connection extends EventEmitter {
  #isAlive = false;
  constructor(url, config) {
    super();
    this.url = url;
    this.config = config;
    this.channels = [];
    this.amqpConnection = null;
    this.alive = false;
    this.reconnectInterval = this.config.reconnectInterval  || 500
    this.timeout = this.config?.timeout || 5000
    this.connection_name = this.config?.connection_name || 'amqp_pool_client'

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
      this.emit('info', { message: 'Connecting', url: this.url})
      amqplib.connect(this.url, {timeout: this.timeout ,clientProperties: {connection_name: this.connection_name}})
      .then((connection) => {
          this.amqpConnection = connection;
          this.amqpConnection.on('close', (e) => {
            this.alive = false;
            this.emit('close', this);
          });
          this.amqpConnection.on('error', (e) => {
            this.emit('error', e)
            // this.alive = false;
          });
          this.alive = true;
          this.emit('info', {message: 'Connection created', url: this.url});
          this.connection()
        })
        .then(() => {
          //this.emit('connection', this);
          //console.log('Ok');
        })
        .catch((error) => {
          this.alive = false;
          this.emit('error', { error: error , url: this.url})
          setTimeout(() => {
            //this.emit('info', { message: 'Retry reconnecting', url: this.url})
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
    if (this.connection) {
      this.connection.close();
    }
  }

}

module.exports = Connection;