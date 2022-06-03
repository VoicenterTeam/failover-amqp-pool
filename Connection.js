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
          this.emit('connection', this);
        })
        .then(() => {
          console.log('Ok');
        })
        .catch((error) => {
          this.alive = false;
          console.log(error)
          console.log("Failed to setup connection");
          setTimeout(() => {
            this.start();
          }, 500);
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