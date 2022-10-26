const amqplib = require('amqplib');
const EventEmitter = require('events').EventEmitter;

class Connection extends EventEmitter {
  constructor(url, config) {
    super();
    this.url = url;
    this.config = config;
    this.channels = [];
    this.amqpConnection = null;
    this.alive = false;
    this.reconnectInterval = this.config.reconnectInterval  || 500
  }

  start() {
    if (!this.alive) {
      amqplib.connect(this.url, {})
        .then((connection) => {
          this.amqpConnection = connection;
          this.amqpConnection.on('close', () => {
            this.alive = false;
            console.log('Connection closes');
            this.emit('close', this);
          });
          this.amqpConnection.on('error', (e) => {
            this.alive = false;
            console.log('Connection error');
            console.log(e);
          });
          this.alive = true;
          this.emit('info', {message: 'Connection created', url: this.url});
          this.emit('connection', this);
        })
        .then(() => {
          //this.emit('connection', this);
          //console.log('Ok');
        })
        .catch((error) => {
          this.alive = false;
          this.emit('error', { error: error , url: this.url})
          setTimeout(() => {
            this.emit('info', { message: 'Retry reconnecting', url: this.url})
            this.start();
          }, this.reconnectInterval);
        });
    }
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