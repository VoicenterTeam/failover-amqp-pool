let process = require('process');
const { watchPool } = require('./telemetry/metrics');


// Filters built by #onlyChannel: their failed retries stay silent, as an 'all' publish is.
const retryFilters = new WeakSet();

// How many times a message the broker refused (a nack, or a channel error) is sent again
// before the pool drops it. A connection drop is no refusal and does not count.
const MAX_RESENDS = 5;
// The longest confirmTimeout stop() takes, ms: setTimeout's own limit
const MAX_WAIT = 2147483647;

// A process warning for a value nobody else will hear, which must not throw itself.
// emitWarning throws on a value that is neither a string nor an Error, and String() throws
// on an object with no prototype or a toString that throws
// (instanceof runs a Proxy's getPrototypeOf trap, and emitWarning reads an Error's name).
// Node prints an Error's warning a tick later, outside this try, reading its code, detail,
// stack and toString: it gets a copy made of strings read here instead.
function warn(value) {
  try {
    if (!(value instanceof Error)) return process.emitWarning(String(value));
    const copy = new Error(String(value.message));
    copy.name = String(value.name);
    const { code, stack } = value;
    if (code) copy.code = String(code);
    if (typeof stack === 'string') copy.stack = stack;
    process.emitWarning(copy);
  } catch {
    process.emitWarning('unprintable value');
  }
}

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
  // Stops the pool and logs; the app owns the exit. stop() keeps the app's listeners, so the
  // app hears the one log. Nothing here may reject: a failure nobody hears, and a listener that
  // throws, become process warnings.
  #onSigint = async () => {
    let failed = false;
    let failure;
    try {
      await this.stop();
    } catch (err) {
      failed = true;
      failure = err;
    }
    if (failed && this.listenerCount('error') === 0) warn(failure);
    const [event, payload] = failed ? ['error', failure] : ['info', 'Pool stopped on SIGINT'];
    for (const fn of this.rawListeners(event)) {
      try {
        fn.call(this, payload);
      } catch (err) {
        warn(err);
      }
    }
  };
  // Listeners the pool put on its Connections and Channels, per emitter: what stop() takes off
  #wired = new WeakMap();
  #stopped = false;
  // Per cached entry, the channels it is done with: they took its message, or are closed
  #done = new WeakMap();
  // While stop() waits for confirms: what the channels hand back, for its one report
  #atStop = null;
  // A cached hand-back -> the Channel that handed it back, for stop()'s channelId
  #handedBy = new WeakMap();
  // An 'all' copy split off for one channel -> that Channel, for stop()'s report
  #splitFor = new WeakMap();

  // A stopped pool is final: it opens, creates and sends nothing. The code lets a caller match
  // the error without its text.
  #assertRunning() {
    if (this.#stopped) throw Object.assign(new Error('Pool is stopped'), { code: 'POOL_STOPPED' });
  }

  // Re-emits each of an emitter's events on the pool, until the pool is stopped
  #forward(emitter, events) {
    const added = events.map(([event, convert]) => {
      const fn = (arg) => {
        if (!this.#stopped) this.emit(event, convert ? convert(arg) : arg);
      };
      emitter.on(event, fn);
      return [event, fn];
    });
    this.#wired.set(emitter, [...(this.#wired.get(emitter) || []), ...added]);
  }
  // A listener of the pool's own on an emitter, which stop() takes off with the forwarded ones
  #wire(emitter, event, fn) {
    emitter.on(event, fn);
    this.#wired.set(emitter, [...(this.#wired.get(emitter) || []), [event, fn]]);
  }
  // A stopped pool emits nothing, and its Connections and Channels still emit late errors,
  // which with no listener would throw
  #unwire(emitter) {
    for (const [event, fn] of this.#wired.get(emitter) || []) emitter.off(event, fn);
    this.#wired.delete(emitter);
    emitter.on('error', () => {});
  }

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
    this.#assertRunning();
    // stop() clears only the last timer, so a restart replaces the one running
    clearInterval(this.interval);
    this.interval = setInterval(() => this.#retry(), msgCacheInterval);
  }

  // One pass down the cache, oldest first, over the entries cached when the tick began: it sends
  // every one a live channel takes. Entries keep their places: one that cannot go out stays
  // where it is, one that went out or was dropped leaves. A channel that fails in the pass is
  // not tried again in it, so its later entries keep their order, and the pass reports only its
  // first failure. The pass's events go out once the cache holds its result.
  #retry() {
    const cache = this.msgCache;
    if (cache.length === 0 || this.getAllChannels().length === 0) return;
    const pass = { failed: new Set(), reported: false };
    const notes = [];
    const kept = [];
    const end = cache.length;
    let at = 0;
    while (at < end && !this.#stopped) {
      const tried = cache[at++];
      const keep = this.#attempt(tried, pass, notes);
      for (const entry of keep) kept.push({ entry, added: entry !== tried });
    }
    // past `at`: any entries a stop() kept the pass from, then any a listener cached during it.
    // Cached entries go back by index; one the pass made (an 'all' split) is added, in its place.
    const rest = cache.slice(at);
    cache.length = 0;
    for (const { entry, added } of kept) {
      if (added) this.#cache(entry);
      else cache[cache.length] = entry;
    }
    for (const entry of rest) cache[cache.length] = entry;
    this.#tell(notes);
  }
  
  // Waits up to confirmTimeout ms for the broker to confirm what the channels hold, then reports
  // what is still unconfirmed once, and closes. A bad confirmTimeout rejects before anything
  // stops.
  async stop({ confirmTimeout = 5000 } = {}) {
    if (!Number.isInteger(confirmTimeout) || confirmTimeout < 0 || confirmTimeout > MAX_WAIT) {
      const got = typeof confirmTimeout === 'number' ? confirmTimeout : typeof confirmTimeout;
      throw new TypeError('stop: confirmTimeout must be a whole number from 0 to ' +
        `${MAX_WAIT}, got ${got}`);
    }
    this.#stopped = true;
    clearInterval(this.interval);
    process.off('SIGINT', this.#onSigint);
    this.#unwatch();
    await this.#waitConfirmed(confirmTimeout);
    // a channel's error while the connections close is expected, and must not throw
    for (const connection of this.connections) {
      for (const channel of connection.channels) this.#unwire(channel);
      this.#unwire(connection);
    }
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

  addConnection(rawConfig) {
    this.#assertRunning();
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
  

  publish(msg, filter, topic, props) {
    this.#assertRunning();
    const notes = [];
    const keep = this.#attempt({ msg, filter, topic, props }, null, notes);
    // with nobody listening, the 'error' throws to the caller, as it always did, and nothing is
    // cached: a caller that publishes again then sends the message once
    if (this.listenerCount('error') === 0 && notes.some(([event]) => event === 'error')) {
      return this.#notify(notes);
    }
    for (const entry of keep) this.#cache(entry);
    this.#notify(notes);
  }

  // Sends one message where its filter points. Returns what stays cached in its place (nothing,
  // the entry itself, or for an 'all' publish one entry per failed channel), and adds to `notes`
  // the events to emit once the cache holds that result. `pass` is the retry tick's, and null
  // for a publish() call.
  #attempt(entry, pass, notes) {
    const { filter, props } = entry;
    const channels = this.getAliveChannels();
    if (typeof filter == 'function') {
      let targets;
      try {
        targets = filter(channels);
      } catch (e) {
        // publish()'s caller hears its own filter's throw. In the tick nobody would: the throw
        // is reported, and the message dropped, as the filter would throw on every tick.
        if (!pass) throw e;
        const info = { message: 'cached message dropped', messageId: props?.messageId };
        notes.push(['error', e], ['info', { ...info, reason: 'filter threw' }]);
        return [];
      }
      if (!targets) return [entry];
      if (targets instanceof Channel) targets = [targets];
      return this.#send(entry, targets, !retryFilters.has(filter), pass, notes);
    }
    if (channels.length === 0) return [entry];
    if (filter === 'rr') {
      if (this.rr_i >= channels.length) this.rr_i = 0;
      return this.#send(entry, [channels[this.rr_i++]], false, pass, notes);
    }
    if (filter !== 'all') return this.#send(entry, [channels[0]], true, pass, notes);
    // each channel that fails keeps an entry of its own, with a filter that reaches it only
    const keep = [];
    for (const channel of channels) {
      const only = { ...entry, filter: this.#onlyChannel(channel, props) };
      this.#splitFor.set(only, channel);
      keep.push(...this.#send(only, [channel], false, pass, notes));
    }
    return keep;
  }

  // Publishes on each target this entry is not done with. The entry stays cached, once, while a
  // target still owes it, and remembers the channels it is done with, which a retry skips.
  // A closed channel takes nothing, now or on a retry: its drop is told once, and nothing waits
  // for it. A RangeError is amqplib refusing the message itself (since 2.3.1, a headers or
  // arguments table over 64 KiB): every retry would fail the same way, so it is reported and
  // nothing waits for it.
  #send(entry, targets, report, pass, notes) {
    const done = this.#done.get(entry);
    const doneNow = [];
    let owed = false;
    for (const key in targets) {
      const channel = targets[key];
      if (this.#stopped) {
        owed = true;
        break;
      }
      if (done?.has(channel)) continue;
      if (channel?.isClosed) {
        notes.push(['info', this.#closedDrop(channel, entry.props)]);
        doneNow.push(channel);
        continue;
      }
      if (pass?.failed.has(channel)) {
        owed = true;
        continue;
      }
      try {
        // an entry a Channel handed back goes out as it was first sent, counted
        if (entry.method) channel.resend(entry);
        else channel.publish(entry.msg, entry.topic, entry.props);
        doneNow.push(channel);
      } catch (e) {
        const refused = e instanceof RangeError;
        if (refused || (report && !pass?.reported)) notes.push(['error', e]);
        if (refused) continue;
        owed = true;
        if (!pass) continue;
        pass.failed.add(channel);
        if (report) pass.reported = true;
      }
    }
    if (!owed) return [];
    if (doneNow.length > 0) this.#done.set(entry, new Set([...(done || []), ...doneNow]));
    return [entry];
  }

  // stop()'s wait: every channel at once, each bounded by ms. A hand-back while it waits is
  // collected with the leftovers, and all of it is reported once: one 'unconfirmed' with the
  // entries, each with its channelId, and one 'info' with the count.
  async #waitConfirmed(ms) {
    const report = [];
    this.#atStop = report;
    const tagged = channel => entries => entries.map(e => ({ ...e, channelId: channel._id }));
    // a channel object the app put in a connection's list itself may not have waitConfirmed
    const holding = this.getAllChannels().filter(c => typeof c?.waitConfirmed === 'function');
    const left = await Promise.all(holding.map(channel =>
      channel.waitConfirmed(ms).then(tagged(channel))));
    // a hand-back scheduled with the confirm that settled the wait comes on this tick
    await new Promise(resolve => process.nextTick(resolve));
    this.#atStop = null;
    report.push(...left.flat());
    // Everything left in the cache is reported too, and the cache ends empty. First the
    // hand-backs still cached for a channel that never came back: written once, never
    // confirmed. Then, in cache order, the messages cached because no channel took them: never
    // written, reason 'unsent', with no channel.
    const cached = this.msgCache.splice(0);
    const handedBack = cached.filter(entry => this.#handedBy.has(entry));
    report.unshift(...handedBack.map(entry => {
      const { filter, ...rest } = entry;
      return { ...rest, channelId: this.#handedBy.get(entry)._id };
    }));
    // filter: the publish strategy ('all', 'rr', the app's own function), so the app can publish
    // it again. An 'all' copy split off for one channel was unsent on that channel only: it is
    // reported as 'all' with that channel's id, never with the pool's internal filter.
    const unsent = cached.filter(entry => !this.#handedBy.has(entry)).map(entry => {
      const split = this.#splitFor.get(entry);
      return {
        method: 'publish', msg: entry.msg, topic: entry.topic, props: entry.props,
        filter: split || retryFilters.has(entry.filter) ? 'all' : entry.filter,
        attempts: 0, refusals: 0, reason: 'unsent', cause: null,
        channelId: split ? split._id : null
      };
    });
    report.push(...unsent);
    if (report.length === 0) return;
    this.#tell([['unconfirmed', report], ['info', {
      message: 'unconfirmed messages at stop', count: report.length, unsent: unsent.length
    }]], true);
  }

  // A Channel's 'unconfirmed' entries: cached for start()'s tick, which sends each again on that
  // channel only. A channel closed with close() takes nothing, and a message the broker refused
  // once more after MAX_RESENDS re-sends is dropped, so one it always refuses does not go round
  // forever. Connection drops never drop a message.
  #unconfirmed(channel, entries) {
    if (this.#atStop) {
      this.#atStop.push(...entries.map(e => ({ ...e, channelId: channel._id })));
      return;
    }
    if (this.#stopped) return;
    const notes = [];
    for (const entry of entries) {
      const drop = channel.isClosed ? 'channel is closed'
        : entry.refusals > MAX_RESENDS ? 'refused too many times' : null;
      if (!drop) {
        const cached = { ...entry, filter: this.#onlyChannel(channel, entry.props) };
        this.#handedBy.set(cached, channel);
        this.#cache(cached);
        continue;
      }
      const info = { message: 'cached message dropped', messageId: entry.props?.messageId,
        channelId: channel._id, reason: drop };
      if (drop !== 'channel is closed') {
        Object.assign(info, { refusals: entry.refusals, attempts: entry.attempts,
          lastReason: entry.reason, cause: entry.cause });
      }
      notes.push(['info', info]);
    }
    this.#tell(notes);
  }

  #notify(notes) {
    for (const [event, payload] of notes) if (!this.#stopped) this.emit(event, payload);
  }

  // The tick's events. The tick runs in a timer, where a throw would end the process, so an
  // 'error' nobody listens to becomes a process warning, and so does a listener's throw. stop()'s
  // own report goes out after the pool is stopped.
  #tell(notes, stopping = false) {
    for (const [event, payload] of notes) {
      if (this.#stopped && !stopping) return;
      if (event === 'error' && this.listenerCount('error') === 0) warn(payload);
      for (const fn of this.rawListeners(event)) {
        try {
          fn.call(this, payload);
        } catch (err) {
          warn(err);
        }
      }
    }
  }

  // The filter a failed 'all' publish is cached with: the Channel object itself (an _id changes
  // on every re-create), while it is alive. While it is still in the pool but down, null, which
  // publish() caches again. Once it is removed from the pool, [], which is truthy and drops the
  // entry: no retry could ever reach it. A channel closed with close() but still listed is as
  // final: the entry is dropped, with one 'info'.
  #onlyChannel(channel, props) {
    const filter = alive => {
      if (alive.includes(channel)) return [channel];
      if (!this.getAllChannels().includes(channel)) return [];
      if (!channel.isClosed) return null;
      this.#dropForClosed(channel, props);
      return [];
    };
    retryFilters.add(filter);
    return filter;
  }

  #dropForClosed(channel, props) {
    this.emit('info', this.#closedDrop(channel, props));
  }

  #closedDrop(channel, props) {
    return {
      message: 'cached message dropped',
      messageId: props?.messageId,
      channelId: channel._id,
      reason: 'channel is closed'
    };
  }

  // The one way into the cache: every message kept for start()'s retry is added here, and only
  // here does the pool push onto msgCache
  #cache(entry) {
    this.msgCache.push(entry);
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
    if (!channels.length && !this.#stopped) {
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
    this.#assertRunning();
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
    this.#assertRunning();
    const connection = this.connections[connectionIndex]
    let channel = new Channel(connection, Channelconfig);
    this.#forward(channel, [
      ['ready'], ['recreated'], ['close'], ['error'], ['channelMessage'], ['info']
    ]);
    this.#wire(channel, 'unconfirmed', entries => this.#unconfirmed(channel, entries));
    connection.addChannel(channel);
    if(connection.alive)
    channel.create();
    return channel._id
  }
}

module.exports = AMQPPool;