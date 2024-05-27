const amqplib = require('amqplib');
const EventEmitter = require('events').EventEmitter;
const os = require('os');
const Metrics = require('./metrics');
const METRICS_NAMES = require('./metrics/names');


class Connection extends EventEmitter {
  #isAlive = false;
  constructor(url, config) {
    super();
    this.url = url;
    this.URL = new URL(this.url)
    this.config = config;
    this.channels = [];
    this.amqpConnection = null;
    this.alive = false;
    this.reconnectInterval = this.config.reconnectInterval  || 500
    this.timeout = this.config?.timeout || 5000
    this.connection_name = this.config?.connection_name || 'amqp_pool_client_' + os.hostname
    this.metrics = new Metrics(this.URL.host)
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
      this.emit('info', { message: 'Connecting', url: this.url})
      amqplib.connect(this.url, {timeout: this.timeout ,clientProperties: {connection_name: this.connection_name}})
      .then((connection) => {
          this.amqpConnection = connection;
          this.amqpConnection.on('close', (e) => {
            this.alive = false;
            setTimeout(() => {
                if(this.reconnectOnClose)
                this.start();
            }, 1000);

            this.emit('close', this);
          });
          this.amqpConnection.on('error', (e) => {
            this.metrics?.metric(METRICS_NAMES.errorRate)?.mark()
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
          this.metrics.metric(METRICS_NAMES.errorRate).mark()
          this.emit('error', { error: error , url: this.url})
          setTimeout(() => {
          this.metrics?.metric(METRICS_NAMES.reconnectedConnectionsCount)?.inc()
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
    this.reconnectOnClose = false;
    if (this.amqpConnection) {
      this.amqpConnection.close();
    }
  }

}

module.exports = Connection;