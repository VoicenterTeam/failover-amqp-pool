function _parsConfig (rawConfig) {
  let parsedConfig = {};
  let pool = rawConfig?.pool || rawConfig
  for (let item in pool) {
    let url = _buildUrl(pool[item].connection);
    parsedConfig[url] = (pool.hasOwnProperty(url)) ? parsedConfig[url] : {};

    parsedConfig[url].channels = (parsedConfig[url].hasOwnProperty('channels')) ? parsedConfig[url].channels : [];
    if(pool[item].hasOwnProperty('channels'))
      parsedConfig[url].channels = parsedConfig[url].channels.concat(pool[item].channels)
    else 
      parsedConfig[url].channels.push(Object.assign( {}, rawConfig?.defaultChannelSettings, pool[item].channel) );
    parsedConfig[url].config = pool[item].connection;
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
      if (this.msgCache.length > 0 && this.getAliveChannels().length > 0) {
        let m = this.msgCache.shift();
        this.publish(m.msg, m.filter, m.topic, m.props);
      }
    }, 500);
    for (let _url in this.config) {
      ((url) => {
        let connection = new Connection(url, this.config[url].config);
        this.connections.push(connection);
        for (let channelConfigIndex in this.config[url].channels) {
          let channel = new Channel(connection, this.config[url].channels[channelConfigIndex]);
          channel.on('ready', (channel) => {
            this.emit('ready', channel);
          });
          channel.on('error', console.error)
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

  // ToDo: Needs some DRYing
  publish(msg, filter, topic, props) {
    topic = topic || this.config.publish?.topic
    if(msg instanceof Object) msg = JSON.stringify(msg)
    let channels = this.getAliveChannels();
    if (typeof filter == 'function') {
      let filteredChannels = filter(channels);
      for (let channelIndex in filteredChannels) {
        try {
          filteredChannels[channelIndex].publish(msg, topic, props);
        } catch (e) {
          console.log('Error in publish', e)
          this.msgCache.push({msg, filter, topic, props});
        }
      }
    } else if (filter === 'rr') {
      if (channels.length > 0 ) {
        if(this.rr_i >= channels.length) {
          this.rr_i = 0;
        }
        try {
          channels[this.rr_i++].publish(msg, topic, props);
        } catch (e) {
          this.msgCache.push({msg, filter, topic, props});
        }
      } else {
        this.msgCache.push({msg, filter, topic, props});
      }
    } else if (filter === 'all') {
      if (channels.length > 0) {
        for (let channelIndex in channels) {
          try {
            channels[channelIndex].publish(msg, topic, props);
          } catch (e) {
            this.msgCache.push({msg, filter, topic, props});
          }
        }
      } else {
        this.msgCache.push({msg, filter, topic, props});
      }
    } else { // first alive
      if (channels.length > 0) {
        try {
          channels[0].publish(msg, topic, props);
        } catch (e) {
          console.log('Error on publish', e)
          this.msgCache.push({msg, filter, topic, props});
        }
      } else {
        this.msgCache.push({msg, filter, topic, props});
      }
    }
  }

  ack(msg) {
    this.getChannelById(msg.properties.channelId).map((channel) => {
      channel.ack(msg);
    });
  }

  nack(msg) {
    this.getChannelById(msg.properties.channelId).map((channel) => {
      channel.nack(msg);
    });
  }

  getAliveChannels() {
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

  getAllChannels() {
    let channels = [];
    for (let connectionIndex in this.connections) {
      for (let channelIndex in this.connections[connectionIndex].channels) {
        channels.push(this.connections[connectionIndex].channels[channelIndex]);
      }
    }
    return channels;
  }

  getChannelById(id) {
    let channels = [];
    for (let connectionIndex in this.connections) {
      for (let channelIndex in this.connections[connectionIndex].channels) {
        if (this.connections[connectionIndex].channels[channelIndex]._id === id) {
          channels.push(this.connections[connectionIndex].channels[channelIndex]);
        }
      }
    }
    return channels;
  }
}

module.exports = AMQPPool;