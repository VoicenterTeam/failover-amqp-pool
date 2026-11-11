const amqplib = require('amqplib');
const EventEmitter = require('events').EventEmitter;
const os = require('os');
const { countConnectionError, countReconnect } = require('./telemetry/metrics');

// emitWarning throws on a value that is neither a string nor an Error, and String() can throw
function warn(value) {
  try {
    process.emitWarning(value instanceof Error ? value : String(value));
  } catch {
    process.emitWarning('a listener threw an unprintable value');
  }
}


class Connection extends EventEmitter {
  #isAlive = false;
  #retryTimer = null;
  #disconnected = false;
  constructor(url, config) {
    super();
    this.url = url;
    this.URL = new URL(this.url)
    // the URL for emitted events: no username or password
    this.safeUrl = Object.assign(new URL(this.url), {username: '', password: ''}).toString()
    this.config = config;
    this.channels = [];
    this.amqpConnection = null;
    this.alive = false;
    this.reconnectInterval = this.config.reconnectInterval  || 1500
    this.timeout = this.config?.timeout || 5000
    this.connection_name = (this.config?.connection_name || 'amqp_pool_client') + `_${os.hostname}`
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

  // The next start() after a failed connect or a close; none once disconnect() has run
  #scheduleRetry() {
    if (!this.reconnectOnClose) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (!this.reconnectOnClose) return;
      countReconnect(this.url);
      this.start();
    }, this.reconnectInterval);
  }

  // A connect that resolved after disconnect(): nothing is waiting for it
  #discard(connection) {
    connection.on('error', () => {});
    try {
      Promise.resolve(connection.close()).catch(() => {});
    } catch (error) {
      // already closing
    }
  }

  // An emit from inside the connect chain (#90). A listener's throw is reported as 'error', and a
  // throw from that report becomes a process warning: neither may reach the connect catch, which
  // would mark this live connection dead and connect again beside it.
  #report(event, payload) {
    try {
      this.emit(event, payload);
    } catch (error) {
      if (event === 'error') return warn(error);
      this.#report('error', { error, url: this.safeUrl });
    }
  }

  start() {
    // a disconnected connection stays down (a connect already in flight is discarded below)
    if (this.#disconnected) return;
    if (!this.alive) {
      // a throw here would break start(), or the retry timer that calls it
      this.#report('info', { message: 'Connecting', url: this.safeUrl})
      amqplib.connect(this.url, {timeout: this.timeout ,clientProperties: {connection_name: this.connection_name}})
      .then((connection) => {
          if (this.#disconnected) return this.#discard(connection);
          this.amqpConnection = connection;
          this.amqpConnection.on('close', (e) => {
            this.alive = false;
            this.#scheduleRetry();

            this.emit('close', { msg: "connection closed", url: this.safeUrl});
          });
          this.amqpConnection.on('error', (error) => {
            countConnectionError(this.url, error);
            // A numeric code is the broker's ConnectionClose (amqplib sets it there only): the
            // close fails every create in flight, and it is reported once, here. A socket error
            // or heartbeat timeout has none, and the creates report as before.
            if (typeof error?.code === 'number') {
              for (const channel of this.channels) channel._connectionRefused?.(error);
            }
            this.emit('error', { error: error , url: this.safeUrl})
          });
          this.alive = true;
          this.#report('info', {message: 'Connection created', url: this.safeUrl});
          this.connection()
          // once per connect, reconnects included; the URL without username or password
          this.#report('connection', this.safeUrl);
        })
        .catch((error) => {
          this.alive = false;
          countConnectionError(this.url, error);
          // the retry is scheduled whatever the 'error' listener does
          this.#report('error', { error: error , url: this.safeUrl})
          this.#scheduleRetry();
        });
    }
  }
  connection(){
    this.channels.forEach( channel => {
      try {
        channel.create()
      } catch (error) {
          this.#report('error', { error: error , url: this.safeUrl})
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

  // Resolves true when amqplib's close() succeeded or there was nothing to close, false when it
  // rejected: the connection is already closed, so no further 'close' will come.
  disconnect() {
    this.#disconnected = true;
    this.alive = false;
    this.reconnectOnClose = false;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    if (!this.amqpConnection) return Promise.resolve(true);
    const closing = Promise.resolve(this.amqpConnection.close()).then(() => true, () => false);
    this.amqpConnection = undefined;
    this.channels = [];
    return closing;
  }

}

module.exports = Connection;