let process = require('process');

function _parsConfig (rawConfig) {
  let parsedConfig = {};
  for (let item in rawConfig) {
    let url = _buildUrl(rawConfig[item].connection);
    parsedConfig[url] = (parsedConfig.hasOwnProperty(url)) ? parsedConfig[url] : {};

    parsedConfig[url].channels = (parsedConfig[url].hasOwnProperty('channels')) ? parsedConfig[url].channels : [];
    parsedConfig[url].channels.push(rawConfig[item].channel);
    parsedConfig[url].config = rawConfig[item].connection;
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
  if (config.hasOwnProperty('heartbeat')) {
    url += '?heartbeat=' + config.heartbeat;
  }
  return url;
}

const Connection = require('./Connection');
const Channel = require('./Channel');
const EventEmitter = require('events').EventEmitter;
const hash = require('object-hash');

class AMQPPool extends EventEmitter {
  constructor(rawConfig) {
    super();
    this.connections = [];
    this.msgCache= [];

    // round_robin
    this.rr_i = 0;

    this.addConnection(rawConfig);

    process.on('SIGINT', () => {
      this.stop(function(err) {
        console.log("Exit on SIGINT");
        process.exit(err ? 1 : 0);
      })
    });
  }

  start(msgCacheInterval = 2000) {
    setInterval(() => {
      if (this.msgCache.length > 0 && this.getAliveChannels().length > 0) {
        let m = this.msgCache.shift();
        this.publish(m.msg, m.filter, m.topic, m.props);
      }
    }, msgCacheInterval);
  }

  stop(cb) {
    for (let _connection of this.connections) {
      _connection.disconnect();
    }
    cb(false);
  }

  addConnection(rawConfig) {
    let config = _parsConfig(rawConfig);
    for (let _url in config) {
      let connectionIndex =  this.getConnectionIndexByUrl(_url);
      if(!connectionIndex) {
        // Create a new connection
        connectionIndex = this.createConnection(_url, config[_url].config);
      }
      for (let channelConfigIndex in config[_url].channels) {
        if(!this.getChannelByHash(connectionIndex, hash(config[_url].channels[channelConfigIndex]))) {
          // Create a new channel
          this.createChannel(connectionIndex, config[_url].channels[channelConfigIndex])
        }
      }
    }
  }

  // ToDo: Needs some DRYing
  publish(msg, filter, topic, props) {
    let channels = this.getAliveChannels();
    if (typeof filter == 'function') {
      let filteredChannels = filter(channels);
      if (!filteredChannels) this.msgCache.push({msg, filter, topic, props});
      else {
        if (filteredChannels instanceof Channel) filteredChannels = [filteredChannels];
        for (let channelIndex in filteredChannels) {
          try {
            filteredChannels[channelIndex].publish(msg, topic, props);
          } catch (e) {
            console.log('Error in publish', e);
            this.msgCache.push({msg, filter, topic, props});
          }
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
          console.log('Error on publish', e);
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

  getChannelByHash(connectionIndex, hash) {
    return this.connections[connectionIndex].channels.find(channel => channel.hash === hash)
  }

  getAllChannels() {
    let channels = [];
    for (let connectionIndex in this.connections) {
      channels = channels.concat(this.connections[connectionIndex].channels);
    }
    return channels;
  }

  getConnectionIndexByUrl(url){
    for (let connectionIndex in this.connections){
      if(this.connections[connectionIndex].url === url){
        return connectionIndex
      }
    }
    return false;
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

  createConnection(url, connectionConfig){
    let connection = new Connection(url, connectionConfig);
    connection.on('close', () => {
      this.emit('close', url)
      setTimeout(() => {
        connection.start();
      }, 500);
    });
    connection.on('error', (error) => this.emit('error', error))
    connection.on('info', (info) => this.emit('info', info))
    connection.on('connection', () => this.emit('connection', url))
    connection.start();
    return this.connections.push(connection) - 1;
  }

  createChannel(connectionIndex, Channelconfig) {
    const connection = this.connections[connectionIndex]
    let channel = new Channel(connection, Channelconfig);
    channel.on('ready', (channel) => this.emit('ready', channel));
    channel.on('close', (close) => this.emit('close', close))
    channel.on('error', (error) => this.emit('error', error))
    channel.on('message', (msg) => this.emit('message', msg));
    channel.on('info', (msg) => this.emit('info', msg));
    connection.addChannel(channel);
  }
}

module.exports = AMQPPool;