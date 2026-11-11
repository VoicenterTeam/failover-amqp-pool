let process = require('process');
const { watchPool } = require('./telemetry/metrics');


// Filters built by #onlyChannel: their failed retries stay silent, as an 'all' publish is.
const retryFilters = new WeakSet();

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
    // amqplib decodes these with unescape(): ASCII round-trips, non-ASCII does not (see README)
    url += encodeURIComponent(config.username) + ':' + encodeURIComponent(config.password) + '@';
  }
  url += config.host + ':' + config.port;
  if (config.vhost) {
    url += '/' + encodeURIComponent(String(config.vhost).replace(/^\//, ''));
  }
  // amqplib 2 reads heartbeat=0 (after parseInt, so also '0.5' or 'abc') as "no heartbeats";
  // before it meant "the server's value", which is what leaving it out gives now
  const heartbeat = parseInt(config.heartbeat, 10);
  if (heartbeat > 0) {
    url += '?heartbeat=' + heartbeat;
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

    process.on('SIGINT', this.#onSigint);
    this.#unwatch = watchPool(() => this.#reading());
  }
  #unwatch;
  // the pool's own SIGINT listener; stop() removes exactly this one
  // Stops the pool and logs; the app owns the exit. stop() clears the pool's listeners, so the
  // app's 'info' and 'error' ones are put back for the one log and taken off again. Nothing here
  // may reject: a failure nobody hears, and a listener that throws, become process warnings.
  #onSigint = async () => {
    // emitWarning throws on a value that is neither a string nor an Error
    const warn = (value) => process.emitWarning(value instanceof Error ? value : String(value));
    const stops = this.#stops;
    const heard = { info: this.rawListeners('info'), error: this.rawListeners('error') };
    let failure;
    try {
      await this.stop();
    } catch (err) {
      failure = err;
    }
    // another stop() ran meanwhile: the app stopped this pool, and has nothing to hear
    if (this.#stops !== stops + 1) {
      if (failure) warn(failure);
      return;
    }
    const restored = [];
    for (const event of Object.keys(heard)) {
      for (const fn of heard[event]) {
        if (this.rawListeners(event).includes(fn)) continue;
        this.on(event, fn);
        restored.push([event, fn]);
      }
    }
    // stop() leaves one no-op 'error' listener of its own; with only that, nobody hears
    if (failure && this.rawListeners('error').length <= 1) warn(failure);
    const [event, payload] = failure ? ['error', failure] : ['info', 'Pool stopped on SIGINT'];
    for (const fn of this.rawListeners(event)) {
      try {
        fn.call(this, payload);
      } catch (err) {
        warn(err);
      }
    }
    for (const [name, fn] of restored) this.off(name, fn);
  };
  #stops = 0;

  // The pool's state for the observable counts; isAlive, as `alive` would re-create channels
  #reading() {
    const connections = [];
    const channels = [];
    for (const connection of this.connections) {
      connections.push({ url: connection.url, alive: connection.alive });
      for (const channel of connection.channels) channels.push({ url: connection.url, alive: channel.isAlive });
    }
    return { connections, channels, cached: this.msgCache.length };
  }
  start(msgCacheInterval = 2000) {
    this.interval = setInterval(() => {
      if (this.msgCache.length > 0 && this.getAllChannels().length > 0) {
        let m = this.msgCache.shift();
        this.publish(m.msg, m.filter, m.topic, m.props);
      }
    }, msgCacheInterval);
  }
  
  async stop() {
    this.#stops++;
    clearInterval(this.interval);
    process.off('SIGINT', this.#onSigint);
    this.#unwatch();
    this.removeAllListeners();
    // a channel's error while the connections close is expected, and must not throw
    this.on('error', () => {});
    return Promise.all([...this.connections].map((connection, index) => new Promise((resolve) => {
      const removed = () => {
        const at = this.connections.indexOf(connection);
        if (at !== -1) this.connections.splice(at, 1);
        resolve(index);
      };
      // a live connection is gone when it has closed, or when its close() was refused; a down
      // one, when its retries are stopped
      const live = connection.alive;
      if (live) connection.once('close', removed);
      const closing = connection.disconnect();
      if (!live) return removed();
      closing.then(closed => {
        if (closed) return;
        connection.off('close', removed);
        removed();
      });
    })));
  }

  // Re-emits each of an emitter's events on the pool
  #forward(emitter, events) {
    for (const [event, convert] of events) {
      emitter.on(event, (arg) => this.emit(event, convert ? convert(arg) : arg));
    }
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
          this.#publishOn(filteredChannels[channelIndex], {msg, filter, topic, props},
            !retryFilters.has(filter));
        }
      }
    } else if (filter === 'rr') {
      if (channels.length > 0 ) {
        if(this.rr_i >= channels.length) {
          this.rr_i = 0;
        }
        this.#publishOn(channels[this.rr_i++], {msg, filter, topic, props}, false);
      } else {
        this.msgCache.push({msg, filter, topic, props});
      }
    } else if (filter === 'all') {
      if (channels.length > 0) {
        for (let channelIndex in channels) {
          const channel = channels[channelIndex];
          this.#publishOn(channel, {msg, filter: this.#onlyChannel(channel), topic, props}, false);
        }
      } else {
        this.msgCache.push({msg, filter, topic, props});
      }
    } else { // first alive
      if (channels.length > 0) {
        this.#publishOn(channels[0], {msg, filter, topic, props}, true);
      } else {
        this.msgCache.push({msg, filter, topic, props});
      }
    }
  }

  // The filter a failed 'all' publish is cached with: the Channel object itself (an _id changes
  // on every re-create), while it is alive. While it is still in the pool but down, null, which
  // publish() caches again. Once it is removed from the pool, [], which is truthy and drops the
  // entry: no retry could ever reach it.
  #onlyChannel(channel) {
    const filter = alive => {
      if (alive.includes(channel)) return [channel];
      return this.getAllChannels().includes(channel) ? null : [];
    };
    retryFilters.add(filter);
    return filter;
  }

  // A failed publish is cached and retried by start(). A RangeError is amqplib refusing the
  // message itself (since 2.3.1, a headers or arguments table over 64 KiB): every retry would
  // fail the same way, so it is reported and not cached.
  #publishOn(channel, entry, reportError) {
    try {
      channel.publish(entry.msg, entry.topic, entry.props);
    } catch (e) {
      const refused = e instanceof RangeError;
      if (reportError || refused) this.emit('error', e);
      if (!refused) this.msgCache.push(entry);
    }
  }

  ack(msg) {
    this.#forChannelOf(msg, 'ack');
  }

  nack(msg) {
    this.#forChannelOf(msg, 'nack');
  }

  // channelId changes on every re-create, so no match means the message came on a replaced
  // channel; the broker already requeued it
  #forChannelOf(msg, op) {
    const channels = this.getChannelById(msg.properties.channelId);
    if (!channels.length) {
      this.emit('info', {
        message: `stale ${op} dropped`,
        messageId: msg.properties.messageId,
        channelId: msg.properties.channelId,
        reason: 'no channel with this channelId'
      });
    }
    channels.forEach(channel => channel[op](msg));
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
  // Resolves once each channel with this id is closed and out of its connection's list. A dead
  // channel has no 'close' coming, so it is removed at once; a live one when it has closed, or
  // when amqplib refused to close it (already closed).
  async removeChannelById(id){
    const removals = [];
    for (const connection of this.connections) {
      for (const channel of connection.channels.filter(candidate => candidate._id === id)) {
        removals.push(new Promise((resolve) => {
          const removed = () => {
            const at = connection.channels.indexOf(channel);
            connection.removeChannel(channel);
            resolve(at);
          };
          const live = channel.isAlive;
          if (live) channel.once('close', removed);
          const closing = channel.close();
          if (!live) return removed();
          closing.then(closed => {
            if (closed) return;
            channel.off('close', removed);
            removed();
          });
        }));
      }
    }
    return Promise.all(removals);
  }

  createConnection(url, connectionConfig){
    let connection = new Connection(url, connectionConfig);
    this.#forward(connection, [
      ['close', () => connection.safeUrl],
      ['error'],
      ['info'],
      ['connection', () => connection.safeUrl]
    ]);
    connection.start();

    return this.connections.push(connection) - 1;
  }

  createChannel(connectionIndex, Channelconfig) {
    const connection = this.connections[connectionIndex]
    let channel = new Channel(connection, Channelconfig);
    this.#forward(channel, [
      ['ready'], ['recreated'], ['close'], ['error'], ['channelMessage'], ['info']
    ]);
    connection.addChannel(channel);
    if(connection.alive)
    channel.create();
    return channel._id
  }
}

module.exports = AMQPPool;