let process = require('process');
const pmx = require('pmx');
const probe = pmx.probe();

function build(pool, parsedConfig){
  let url = _buildUrl(pool.connection);
  parsedConfig[url] = (pool.hasOwnProperty(url)) ? parsedConfig[url] : {};

  parsedConfig[url].channels = (parsedConfig[url].hasOwnProperty('channels')) ? parsedConfig[url].channels : [];
  if(pool.hasOwnProperty('channels'))
    parsedConfig[url].channels = parsedConfig[url].channels.concat(pool.channels)
  else 
    parsedConfig[url].channels.push(Object.assign( {}, pool?.defaultChannelSettings, pool.channel) );
  parsedConfig[url].config = pool.connection;

  return parsedConfig;
}

function _parsConfig (rawConfig) {
  let parsedConfig = {};
  for (let item in rawConfig) {
    build(rawConfig[item], parsedConfig)
  }
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
        this.emit('info', "Exit on SIGINT")
        process.exit(err ? 1 : 0);
      })
    });

    // Metrics used to work with connections
    this.activeConnectionsCount = probe.metric({
      name: 'rabbit_connections_total_count',
      value: () => this.connections.length
    })

    this.reconnectedConnectionsCount = probe.counter({
      name: 'rabbit_reconnected_connections_count',
    })

    // Metrics used to work with channels
    this.aliveChannelsCount = probe.metric({
      name: 'rabbit_alive_channels_count',
      value: () => (this.getAliveChannels()).length,
      interval: 10 * 60 * 60 // Check every 10 minutes
    })

    this.allChannelsCount = probe.metric({
      name: 'rabbit_all_channels_count',
      value: () => (this.getAllChannels()).length,
      interval: 10 * 60 * 60 // Check every 10 minutes
    })

    // Metrics used to work with messages
    this.messageSuccessRate = probe.meter({
      name: 'rabbit_message_success_rate',
      samples: 1_000_000, // Keep in memory up to 1 million records for last 8 hours
      timeframe: 8 * 60 * 60 // keep track of last 8 hours
    })
    
    this.messageTotalCount = probe.counter({
      name: 'rabbit_message_total_count',
    })

    this.messageCachedCount = probe.metric({
      name: 'rabbit_message_cached_count', 
      value: () => this.msgCache.length
    })
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
    this.messageTotalCount.inc();
    let channels = this.getAliveChannels();
    if (typeof filter == 'function') {
      let filteredChannels = filter(channels);
      if (!filteredChannels) this.msgCache.push({msg, filter, topic, props});
      else {
        if (filteredChannels instanceof Channel) filteredChannels = [filteredChannels];
        for (let channelIndex in filteredChannels) {
          try {
            filteredChannels[channelIndex].publish(msg, topic, props);
            this.messageSuccessRate.mark(true);
          } catch (e) {
            this.emit('error', e)
            this.msgCache.push({msg, filter, topic, props});
            this.messageSuccessRate.mark(false);
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
          this.messageSuccessRate.mark(true);
        } catch (e) {
          this.msgCache.push({msg, filter, topic, props});
          this.messageSuccessRate.mark(false);
        }
      } else {
        this.msgCache.push({msg, filter, topic, props});
      }
    } else if (filter === 'all') {
      if (channels.length > 0) {
        for (let channelIndex in channels) {
          try {
            channels[channelIndex].publish(msg, topic, props);
            this.messageSuccessRate.mark(true);
          } catch (e) {
            this.msgCache.push({msg, filter, topic, props});
            this.messageSuccessRate.mark(false);
          }
        }
      } else {
        this.msgCache.push({msg, filter, topic, props});
      }
    } else { // first alive
      if (channels.length > 0) {
        try {
          channels[0].publish(msg, topic, props);
          this.messageSuccessRate.mark(true);
        } catch (e) {
          
          this.emit('error', e)
          this.msgCache.push({msg, filter, topic, props});
          this.messageSuccessRate.mark(false);
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
      this.reconnectedConnectionsCount.inc();
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
    channel.on('close', (close) => this.emit('close', close));
    channel.on('error', (error) => this.emit('error', error));
    channel.on('channelMessage', (msg) => this.emit('channelMessage', msg));
    channel.on('info', (msg) => this.emit('info', msg));
    connection.addChannel(channel);
  }
}

module.exports = AMQPPool;