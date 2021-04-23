function _parsConfig (rawConfig) {
  let parsedConfig = {};
  for (let item in rawConfig) {
    let url = _buildUrl(rawConfig[item].connection);
    parsedConfig[url] = (parsedConfig.hasOwnProperty(url)) ? parsedConfig[url] : [];
    parsedConfig[url].push(rawConfig[item].channel);
  }
  // console.log(parsedConfig)
  return parsedConfig;
}

function _buildUrl(config) {
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

const Connection = require('./Connection');
const Channel = require('./Channel');
const EventEmitter = require('events').EventEmitter;

class AMQPPool extends EventEmitter {
  constructor(rawConfig) {
    super();

    this.config = _parsConfig(rawConfig);
    this.connections = [];

    // round_robin
    this.rr_i = 0;
  }

  start() {
    for (let _url in this.config) {
      ((url) => {
        let connection = new Connection(url);
        this.connections.push(connection);
        for (let channelConfigIndex in this.config[url]) {
          let channel = new Channel(connection, this.config[url][channelConfigIndex]);
          channel.on('ready', (channel) => {
            this.emit('ready', channel);
          });
          channel.on('message', (msg) => {
            this.emit('message', msg);
          });
        }
        connection.on('close', () => {
          console.log('close ' + url);
          this.connections.splice(this.connections.indexOf(connection), 1);
          setTimeout(() => {
            connection.start();
          }, 500);
        });
        connection.start();
      })(_url);
    }
  }

  publish(msg, filter) {
    let channels = this.getAllChannels();
    if (typeof filter == 'function') {
      // console.log(this.connections);
      filter.call(this, msg, channels);
    } else if (filter === 'rr') {
      if (channels.length > 0 ) {
        if(this.rr_i >= channels.length) {
          this.rr_i = 0;
        }
        console.log(channels[this.rr_i].exchange);
        channels[this.rr_i++].publish(msg);
      }
    } else if (filter === 'all') {
      for (let channelIndex in channels) {
        console.log(channels[channelIndex].exchange);
        channels[channelIndex].publish(msg);
      }
    }
  }

  getAllChannels() {
    let channels = [];
    for (let connectionIndex in this.connections) {
      if (this.connections[connectionIndex].alive) {
        for (let channelIndex in this.connections[connectionIndex].channels) {
          if (this.connections[connectionIndex].channels[channelIndex].alive) {
            channels.push(this.connections[connectionIndex].channels[channelIndex]);
          }
        }
      }
    }
    return channels;
  }
}

module.exports = AMQPPool;