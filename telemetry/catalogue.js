// Every span, instrument and attribute the pool records, in one place. The names follow the
// OTel messaging semantic conventions, inlined: the pool depends on @opentelemetry/api only.
// Names the conventions do not cover start with amqp_pool.
const { version } = require('../package.json');

/** The meter's and the tracer's name and version. */
const SCOPE = Object.freeze({ name: '@voicenter-team/failover-amqp-pool', version });

const ATTR = Object.freeze({
  system: 'messaging.system',
  operationName: 'messaging.operation.name',
  operationType: 'messaging.operation.type',
  destination: 'messaging.destination.name',
  temporary: 'messaging.destination.temporary',
  address: 'server.address',
  port: 'server.port',
  errorType: 'error.type',
  state: 'amqp_pool.state',
});

const SYSTEM = 'rabbitmq';

/** The port each scheme listens on unless told otherwise; server.port is then left out. */
const DEFAULT_PORTS = Object.freeze({ 'amqp:': 5672, 'amqps:': 5671 });

// The conventions name the nameless default exchange amq.default.
const DEFAULT_EXCHANGE = 'amq.default';

// error.type of a failed publish or listener: channel_dead, the thrown error's class when it is
// one of these, else _OTHER, as the conventions name an unknown type. A connection error's is
// the broker's or the socket's code instead.
const ERROR_TYPES = ['channel_dead', 'Error', 'RangeError', 'TypeError', '_OTHER'];

/**
 * A list holds every value the attribute takes. null: the value comes from the pool's config
 * (a server, an exchange or queue name) or from the broker's or the socket's own error code,
 * never from a message.
 */
const server = { [ATTR.address]: null, [ATTR.port]: null };
const errorType = { [ATTR.errorType]: null };
const thrown = { [ATTR.errorType]: ERROR_TYPES };
const system = { [ATTR.system]: [SYSTEM] };

const PUBLISH_SPAN = {
  name: 'publish {messaging.destination.name}',
  kind: 'producerSpan',
  unit: '',
  description: 'One message handed to amqplib, its trace context in the message headers.',
  attributes: {
    ...system,
    [ATTR.operationName]: ['publish'],
    [ATTR.operationType]: ['send'],
    [ATTR.destination]: null,
    ...server,
    ...thrown,
  },
};

const PROCESS_SPAN = {
  name: 'process {messaging.destination.name}',
  kind: 'consumerSpan',
  unit: '',
  description:
    "One delivery's 'message' listeners, run synchronously; the parent is the publisher's span when the headers carry one.",
  attributes: {
    ...system,
    [ATTR.operationName]: ['process'],
    [ATTR.operationType]: ['process'],
    [ATTR.destination]: null,
    [ATTR.temporary]: [true],
    ...server,
    ...thrown,
  },
};

const SENT = {
  name: 'messaging.client.sent.messages',
  kind: 'counter',
  unit: '{message}',
  description: 'Messages a channel was asked to publish; a failed one carries error.type.',
  attributes: { ...PUBLISH_SPAN.attributes },
};

const CONSUMED = {
  name: 'messaging.client.consumed.messages',
  kind: 'counter',
  unit: '{message}',
  description: 'Deliveries a channel handed to its listeners.',
  attributes: {
    ...system,
    [ATTR.operationName]: ['process'],
    [ATTR.operationType]: ['process'],
    [ATTR.destination]: null,
    [ATTR.temporary]: [true],
    ...server,
  },
};

const SETTLED = {
  name: 'amqp_pool.client.settled.messages',
  kind: 'counter',
  unit: '{message}',
  description: 'Acks and nacks sent to the broker; a stale one, dropped, is not counted.',
  attributes: {
    ...system,
    [ATTR.operationName]: ['ack', 'nack'],
    [ATTR.operationType]: ['settle'],
    [ATTR.destination]: null,
    [ATTR.temporary]: [true],
    ...server,
  },
};

const CONNECTION_ERRORS = {
  name: 'amqp_pool.connection.errors',
  kind: 'counter',
  unit: '{error}',
  description: 'Failed connects and errors on an open connection, by the broker or socket code.',
  attributes: { ...system, ...server, ...errorType },
};

const RECONNECTS = {
  name: 'amqp_pool.connection.reconnects',
  kind: 'counter',
  unit: '{reconnect}',
  description: 'Reconnects scheduled, after a failed connect or a closed connection.',
  attributes: { ...system, ...server },
};

const CONNECTIONS = {
  name: 'amqp_pool.connection.count',
  kind: 'observableUpDownCounter',
  unit: '{connection}',
  description: "A pool's connections, by state.",
  attributes: { ...system, ...server, [ATTR.state]: ['alive', 'down'] },
};

const CHANNELS = {
  name: 'amqp_pool.channel.count',
  kind: 'observableUpDownCounter',
  unit: '{channel}',
  description: "A pool's channels, by state.",
  attributes: { ...system, ...server, [ATTR.state]: ['alive', 'down'] },
};

const CACHED = {
  name: 'amqp_pool.message.cached',
  kind: 'observableUpDownCounter',
  unit: '{message}',
  description: "Messages in a pool's cache, waiting for a channel to publish on.",
  attributes: { ...system },
};

const CATALOGUE = Object.freeze([
  PUBLISH_SPAN,
  PROCESS_SPAN,
  SENT,
  CONSUMED,
  SETTLED,
  CONNECTION_ERRORS,
  RECONNECTS,
  CONNECTIONS,
  CHANNELS,
  CACHED,
]);

module.exports = {
  SCOPE,
  ATTR,
  SYSTEM,
  DEFAULT_PORTS,
  DEFAULT_EXCHANGE,
  ERROR_TYPES,
  PUBLISH_SPAN,
  PROCESS_SPAN,
  SENT,
  CONSUMED,
  SETTLED,
  CONNECTION_ERRORS,
  RECONNECTS,
  CONNECTIONS,
  CHANNELS,
  CACHED,
  CATALOGUE,
};
