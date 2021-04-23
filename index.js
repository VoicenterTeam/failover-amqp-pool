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
    this.msgCache= [];

    // round_robin
    this.rr_i = 0;
  }

  start() {
    setInterval(() => {
      if (this.msgCache.length > 0 && this.getAllChannels().length > 0) {
        let m = this.msgCache.shift();
        this.publish(m.msg, m.filter);
      }
    }, 500);
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
          connection.addChannel(channel);
        }
        connection.on('close', () => {
          console.log('close ' + url);
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
        console.log(this.rr_i);
        channels[this.rr_i++].publish(msg);
      } else {
        this.msgCache.push({msg, filter});
      }
    } else if (filter === 'all') {
      if (channels.length > 0) {
        for (let channelIndex in channels) {
          console.log(channels[channelIndex].exchange);
          channels[channelIndex].publish(msg);
        }
      } else {
        this.msgCache.push({msg, filter});
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