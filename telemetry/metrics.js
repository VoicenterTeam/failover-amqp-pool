// The instruments of the catalogue. The API has no proxy meter, so an instrument made before an
// SDK starts stays a no-op: they are rebuilt whenever the global meter provider changes, checked
// once per record. Nothing here throws: telemetry never fails a publish, a delivery or a connect.
const { createNoopMeter, metrics } = require('@opentelemetry/api');
const {
  ATTR,
  CACHED,
  CHANNELS,
  CONNECTION_ERRORS,
  CONNECTIONS,
  CONSUMED,
  DEFAULT_EXCHANGE,
  DEFAULT_PORTS,
  ERROR_TYPES,
  RECONNECTS,
  SCOPE,
  SENT,
  SETTLED,
  SYSTEM,
} = require('./catalogue');

// Every live pool's reader; a pool removes its own on stop().
const pools = new Set();
let built;

const options = row => ({ unit: row.unit, description: row.description });

function build(meter, provider) {
  const sent = meter.createCounter(SENT.name, options(SENT));
  const consumed = meter.createCounter(CONSUMED.name, options(CONSUMED));
  const settled = meter.createCounter(SETTLED.name, options(SETTLED));
  const errors = meter.createCounter(CONNECTION_ERRORS.name, options(CONNECTION_ERRORS));
  const reconnects = meter.createCounter(RECONNECTS.name, options(RECONNECTS));
  const connections = meter.createObservableUpDownCounter(CONNECTIONS.name, options(CONNECTIONS));
  const channels = meter.createObservableUpDownCounter(CHANNELS.name, options(CHANNELS));
  const cached = meter.createObservableUpDownCounter(CACHED.name, options(CACHED));
  const observables = [connections, channels, cached];
  const callback = result => observe(result, connections, channels, cached);
  meter.addBatchObservableCallback(callback, observables);
  const release = () => meter.removeBatchObservableCallback(callback, observables);
  const live = meter !== createNoopMeter();
  return { provider, live, sent, consumed, settled, errors, reconnects, release };
}

// A provider set again later still holds the old build's callback, which would read every pool
// once more per collection.
function release(old) {
  try {
    old?.release();
  } catch {
    // A meter that cannot remove it costs only extra reads.
  }
}

// The instruments of the current global provider; a provider that throws gets no-ops until the
// global changes again.
function instruments() {
  let provider;
  try {
    provider = metrics.getMeterProvider();
    if (built && built.provider === provider) return built;
    release(built);
    built = build(provider.getMeter(SCOPE.name, SCOPE.version), provider);
  } catch {
    release(built);
    built = build(createNoopMeter(), provider);
  }
  return built;
}

// Two pools on one server are one series: their counts are summed before they are observed.
function observe(result, connections, channels, cached) {
  const counts = { connections: new Map(), channels: new Map() };
  let waiting = 0;
  const row = (map, url) => {
    const server = serverAttributes(url);
    const key = JSON.stringify(server);
    if (!map.has(key)) map.set(key, { server, alive: 0, down: 0 });
    return map.get(key);
  };
  const tally = (map, url, alive) => { row(map, url)[alive ? 'alive' : 'down']++; };
  for (const read of pools) {
    try {
      const reading = read();
      reading.connections.forEach(c => {
        tally(counts.connections, c.url, c.alive);
        // a server with no channel left reads 0, or the SDK keeps repeating its last count
        row(counts.channels, c.url);
      });
      reading.channels.forEach(c => tally(counts.channels, c.url, c.alive));
      waiting += reading.cached;
    } catch {
      // One pool that cannot be read hides only its own counts.
    }
  }
  for (const [map, instrument] of [[counts.connections, connections], [counts.channels, channels]]) {
    for (const { server, alive, down } of map.values()) {
      const attributes = { [ATTR.system]: SYSTEM, ...server };
      result.observe(instrument, alive, { ...attributes, [ATTR.state]: 'alive' });
      result.observe(instrument, down, { ...attributes, [ATTR.state]: 'down' });
    }
  }
  if (pools.size) result.observe(cached, waiting, { [ATTR.system]: SYSTEM });
}

// server.address and server.port of a connection URL, kept per URL; the port only when it is
// not the scheme's default. Never the URL's credentials.
const servers = new Map();
function serverAttributes(url) {
  let server = servers.get(url);
  if (server) return server;
  server = {};
  try {
    const parsed = new URL(url);
    server[ATTR.address] = parsed.hostname.replace(/^\[|\]$/g, '');
    const port = Number(parsed.port);
    if (port && port !== DEFAULT_PORTS[parsed.protocol]) server[ATTR.port] = port;
  } catch {
    // An unparsable URL is named by nothing.
  }
  servers.set(url, server);
  return server;
}

/**
 * messaging.destination.name of an exchange, or of a queue; a queue the pool named for itself
 * is messaging.destination.temporary instead, so its per-channel name grows no series.
 */
function destinationAttributes({ name, temporary }) {
  if (temporary) return { [ATTR.temporary]: true };
  return { [ATTR.destination]: name || DEFAULT_EXCHANGE };
}

/** The attributes a publish's span and its count share. */
function publishAttributes(url, exchange) {
  return {
    [ATTR.system]: SYSTEM,
    [ATTR.operationName]: 'publish',
    [ATTR.operationType]: 'send',
    ...destinationAttributes({ name: exchange }),
    ...serverAttributes(url),
  };
}

/** The attributes a delivery's span and its count share. */
function processAttributes(url, queue) {
  return {
    [ATTR.system]: SYSTEM,
    [ATTR.operationName]: 'process',
    [ATTR.operationType]: 'process',
    ...destinationAttributes(queue),
    ...serverAttributes(url),
  };
}

/** error.type of a thrown error: its class when the catalogue lists it, else _OTHER. */
function thrownType(error) {
  const name = error?.constructor?.name;
  return ERROR_TYPES.includes(name) && name !== 'channel_dead' ? name : '_OTHER';
}

// error.type of a connection error: the broker's reply code (320 CONNECTION_FORCED) or the
// socket's (ECONNREFUSED), else the error's class.
function connectionErrorType(error) {
  const code = error?.code;
  if (Number.isInteger(code)) return String(code);
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code)) return code;
  return thrownType(error);
}

// No meter SDK: nothing would be counted, so no attribute work.
function add(counter, attributes) {
  try {
    const built = instruments();
    if (!built.live) return;
    built[counter].add(1, attributes());
  } catch {
    // Telemetry never fails a call.
  }
}

/** Counts one message a channel was asked to publish; errorType when it failed. */
function countSent(url, exchange, errorType) {
  add('sent', () => {
    const attributes = publishAttributes(url, exchange);
    if (errorType) attributes[ATTR.errorType] = errorType;
    return attributes;
  });
}

/** Counts one delivery handed to a channel's listeners. */
function countConsumed(url, queue) {
  add('consumed', () => processAttributes(url, queue));
}

/** Counts one ack or nack sent to the broker. */
function countSettled(url, op, queue) {
  add('settled', () => ({
    ...processAttributes(url, queue),
    [ATTR.operationName]: op,
    [ATTR.operationType]: 'settle',
  }));
}

/** Counts one failed connect or one error on an open connection. */
function countConnectionError(url, error) {
  add('errors', () => ({
    [ATTR.system]: SYSTEM,
    ...serverAttributes(url),
    [ATTR.errorType]: connectionErrorType(error),
  }));
}

/** Counts one reconnect as it starts. */
function countReconnect(url) {
  add('reconnects', () => ({ [ATTR.system]: SYSTEM, ...serverAttributes(url) }));
}

/**
 * Reports `read`'s connections, channels and cached messages at each collection, until the
 * returned function is called. read() returns { connections: [{url, alive}], channels:
 * [{url, alive}], cached }.
 */
function watchPool(read) {
  pools.add(read);
  try {
    instruments();
  } catch {
    // The next record builds them.
  }
  return () => pools.delete(read);
}

module.exports = {
  countSent,
  countConsumed,
  countSettled,
  countConnectionError,
  countReconnect,
  watchPool,
  publishAttributes,
  processAttributes,
  thrownType,
};
