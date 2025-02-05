let process = require('process');
const Metrics = require('./metrics')
const METRICS_NAMES = require('./metrics/names')


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
    this.interval;

    // round_robin
    this.rr_i = 0;

    this.addConnection(rawConfig);

    process.on('SIGINT', () => {
      this.stop((err) =>  {
        this.emit('info', "Exit on SIGINT")
        process.exit(err ? 1 : 0);
      })
    });
    this.metrics = new Metrics()

    // Metrics used to work with connections
  }
  start(msgCacheInterval = 2000) {
    this.interval = setInterval(() => {
      let aliveChannels = this.getAllChannels().length
      this.metrics.metric({
        type: 'gauge',
        name: 'rabbit_message_cached_count', 
        value: () => this.msgCache.length,
      })
      this.metrics.metric({
        type: 'gauge',
        name: 'rabbit_all_channels_count',
        value: () => (this.getAllChannels()).length,
      })
      this.metrics.metric({
        type: 'gauge',
        name: 'rabbit_alive_channels_count',
        value: () => aliveChannels
      })
      this.metrics.metric({
        type: 'gauge',
        name: 'rabbit_connections_total_count',
        value: () => this.connections.length,
      })

      if (this.msgCache.length > 0 && aliveChannels > 0) {
        let m = this.msgCache.shift();
        this.publish(m.msg, m.filter, m.topic, m.props);
      }
    }, msgCacheInterval);
  }
  
  async stop() {
    let promises = []
    clearInterval(this.interval);
    this.removeAllListeners();
    for (const [connectionIndex, _connection] of this.connections.entries()) {
      promises.push(
        new Promise( (resolve) => {
          if(!_connection.alive){
              this.connections.splice(connectionIndex, 1);
              return resolve(connectionIndex)
          }
        _connection.once('close', () => {
          this.connections.splice(connectionIndex, 1);
          resolve(connectionIndex)
        })
        _connection.disconnect();
      })
      )
    }
    return Promise.all(promises)
  }

  addConnection(rawConfig) {
    let channelIds = []
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
          let id = this.createChannel(connectionIndex, config[_url].channels[channelConfigIndex])
          channelIds.push(id)
        }
      }
    }
    return channelIds
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
            this.emit('error', e)
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
          
          this.emit('error', e)
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
  async removeChannelById(id){
    let promises = []
    for (let connectionIndex in this.connections) {
      for (let channelIndex in this.connections[connectionIndex].channels) {
        if (this.connections[connectionIndex].channels[channelIndex]._id === id) {
          promises.push(
            new Promise( (resolve) => {
              this.connections[connectionIndex].channels[channelIndex].once('close', () => {
                this.connections[connectionIndex].channels.splice(channelIndex, 1);
                resolve(channelIndex)
              })
              this.connections[connectionIndex].channels[channelIndex]?.close()
            })
          )
                    
        }
      }
    }
    return Promise.all(promises)
  }

  createConnection(url, connectionConfig){
    let connection = new Connection(url, connectionConfig);
    connection.on('close', () => {
      this.emit('close', url)
      connection?.metrics?.metric(METRICS_NAMES.reconnectedConnectionsCount)?.inc()
    });
    connection.on('error', (error) => {
      
      this.emit('error', error)
    })
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
    channel.on('channelMessage', (msg) => {
      this.emit('channelMessage', msg)
    });
    channel.on('info', (msg) => this.emit('info', msg));
    connection.addChannel(channel);
    if(connection.alive)
    channel.create();
    return channel._id
  }
}

module.exports = AMQPPool;