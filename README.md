# Failover AMQP Pool Client

A robust AMQP client with connection pooling, automatic failover, and Winston transport support.

## Features

- Multiple connection support with automatic failover
- Channel pooling and management
- Automatic reconnection on connection failures
- Built-in metrics tracking
- Winston transport integration
- Support for different message publishing strategies
- Configurable queue and exchange settings
- Flexible message consumption patterns

## Breaking changes in 3.0.0

- `'ready'` fires once per channel, on its first successful create. Recovery (a re-create after
  the channel or its connection closed) emits the new `'recreated'` event instead. Code that
  used `'ready'` as a "back up" or health signal must also listen to `'recreated'`
  (see [Health flag](#health-flag)).
- A channel that was consuming re-consumes by itself after a re-create, and `consume()` is
  idempotent per amqplib channel. A consumer that deliberately stopped consuming after a
  re-create now resumes.
- `ack()`/`nack()` of a message delivered on a previous channel is dropped with an `'info'`
  event `{ message: 'stale ack dropped' | 'stale nack dropped', messageId, channelId, reason }`,
  on both the channel and the pool.
- `'channel is dead!'` and `'Message is null'` errors carry `{ message, channelId, queue, exchange }`,
  and `'DELIVERY TAG NOT FOUND ...'` errors the same plus `messageId`, instead of the `Channel`
  object (the `channel`, `m` and `msg` keys are gone).
- URLs in emitted events (`url` in connection `'info'`/`'error'`/`'close'` events and in
  `'message published'` info, the pool `'close'` and `'connection'` event argument) no longer
  carry the username and password: `amqp://host:port/vhost?...`. `'my connection is dead!!!'`
  errors carry no URL.
- The pool `'close'` argument is that credential-free URL, so it does not match
  `getConnectionIndexByUrl()` (which compares the full URL), and two connections that differ
  only in username or password look the same in events.
- `'ready'`/`'recreated'` are not emitted when a create fails. A failed create leaves the
  channel not alive, emits an `'info'` event
  `{ message: 'channel create failed', channelId, queue, exchange, error }` (no
  `'channel created'` info), and retries with backoff (see [Channel re-creates](#channel-re-creates)).

## Installation

```bash
npm install @voicenter-team/failover-amqp-pool
```

## Basic Usage

```javascript
const AMQPPool = require('@voicenter-team/failover-amqp-pool');

const config = [{
  connection: {
    host: 'localhost',
    port: 5672,
    username: 'guest',
    password: 'guest',
    vhost: '/',
    ssl: false,
    heartbeat: 25
  },
  channel: {
    prefetch: 1,
    exchange: {
      name: 'my-exchange',
      type: 'topic',
      options: {
        durable: true
      }
    },
    queue: {
      name: 'my-queue',
      options: {
        durable: true,
        exclusive: false,
        autoDelete: false
      }
    },
    binding: {
      enabled: true,
      pattern: 'routing.key.*',
      options: {
        headers: {}
      }
    }
  }
}];

const amqp = new AMQPPool(config);

// Handle events
amqp.on('error', console.error);
amqp.on('info', console.log);
amqp.on('ready', (channel) => {
  console.log('Channel ready:', channel._id);
});

// Handle incoming messages
amqp.on('channelMessage', (msg) => {
  console.log('Received:', msg.content.toString());
  amqp.ack(msg); // Acknowledge the message
});

// Start the pool
amqp.start();
```

## Message Consumption

### Auto-Consume Setup
To enable automatic consumption when the channel is created:

```javascript
const config = [{
  connection: {...},
  channel: {
    autoConsume: true,  // Enable auto-consumption
    queue: {
      name: 'my-queue'
    },
    // ... other channel config
  }
}];
```

### Manual Channel Consumption
You can manually start consuming on specific channels:

```javascript
// Get all channels
const channels = amqp.getAllChannels();

// Consume from a specific channel
channels[0].consume();

// Get specific channel by ID
const channel = amqp.getChannelById('channel-id')[0];
if(channel) {
  channel.consume();
}

// Handle messages at channel level
channel.on('message', (msg) => {
  console.log('Channel received:', msg.content.toString());
  channel.ack(msg);
});
```

### Dynamic Queue Creation
Channels can create queues dynamically if no queue name is specified:

```javascript
const config = [{
  connection: {...},
  channel: {
    exchange: {
      name: 'my-exchange',
      type: 'topic'
    },
    binding: {
      enabled: true,
      pattern: 'routing.key.*'
    }
    // No queue name specified - will create dynamic queue
  }
}];
```

### Message Acknowledgement
```javascript
// Acknowledge a message
amqp.ack(msg);

// Negative acknowledge (reject) a message
amqp.nack(msg);

// At channel level
channel.ack(msg);
channel.nack(msg);
```

## Adding New Connections

You can dynamically add new connections to the pool:

```javascript
amqp.addConnection([{
  connection: {
    host: 'another-host',
    port: 5672,
    username: 'guest',
    password: 'guest'
  },
  channel: {
    prefetch: 1,
    exchange: {
      name: 'another-exchange',
      type: 'topic'
    },
    queue: {
      name: 'another-queue'
    }
  }
}]);
```

## Publishing Messages

### Publishing Strategies

- `'all'`: Publish to all available channels
- `'rr'`: Round-robin publishing across channels
- Custom function: Provide a custom filter function

```javascript
// Publish to all channels
amqp.publish(message, 'all', routingKey);

// Round-robin publishing
amqp.publish(message, 'rr', routingKey);

// Custom filter
amqp.publish(message, (channels) => {
  return channels.filter(channel => channel.exchange.name === 'specific-exchange');
}, routingKey);

// Publishing with options
amqp.publish(message, 'all', routingKey, {
  persistent: true,
  priority: 1,
  expiration: '60000'
});
```

## Full Configuration Options

```javascript
{
  connection: {
    host: 'localhost',           // RabbitMQ host
    port: 5672,                  // RabbitMQ port
    ssl: false,                  // Enable SSL/TLS
    username: 'guest',           // Username
    password: 'guest',           // Password (URL-encoded for you; ASCII only, see below)
    vhost: '/',                  // Virtual host
    heartbeat: 25,              // Heartbeat interval in seconds
    timeout: 5000,              // Connection timeout
    reconnectInterval: 1500,    // Reconnection interval on failure, and the first channel create retry wait
    channelRetryMaxInterval: 30000 // Ceiling for the doubling channel create retry wait
  },
  channel: {
    prefetch: 1,                // Channel prefetch count
    autoConsume: false,         // Auto-start consuming
    exchange: {
      name: 'exchange-name',    // Exchange name
      type: 'topic',            // Exchange type (topic, fanout, direct, headers)
      options: {
        durable: true,          // Survive broker restarts
        autoDelete: false,      // Delete when no queues bound
        exclusive: false,       // Exclusive to connection
        alternateExchange: ''   // Alternate exchange for unrouted messages
      }
    },
    queue: {
      name: 'queue-name',       // Queue name
      options: {
        exclusive: false,       // Exclusive to connection
        durable: true,         // Survive broker restarts
        autoDelete: false,     // Delete when last consumer unsubscribes
        messageTtl: 3600000,   // Message TTL in ms
        expires: undefined,    // Queue expiry in ms
        deadLetterExchange: '', // Dead letter exchange
        deadLetterRoutingKey: '', // Dead letter routing key
        maxLength: undefined,  // Maximum queue length
        maxPriority: undefined, // Maximum priority
        queueMode: undefined,  // Queue mode
        arguments: {           // Additional arguments
          "x-consumer-timeout": 7200000
        }
      }
    },
    binding: {
      enabled: true,           // Enable queue-exchange binding
      pattern: '',            // Binding pattern/routing key
      options: {}            // Binding options (headers for header exchange)
    }
  }
}
```

`username` and `password` are URL-encoded when the connection URL is built, so characters
such as `/ ? # @ : % +` and spaces work. Non-ASCII credentials do not: amqplib 0.10 decodes
URL credentials with `unescape()`, so a password like `pässwörd` reaches RabbitMQ mangled and
the login is refused. Use ASCII credentials.

## Winston Transport

The package includes a Winston transport:

```javascript
const winston = require('winston');
const WinstonAMQPPool = require('@voicenter-team/failover-amqp-pool/winston');

const logger = winston.createLogger({
  transports: [
    new WinstonAMQPPool({
      pool: config,
      strategy: 'all',
      topic: 'logs',
      useSymbol: true
    })
  ]
});
```

## Events

The pool emits several events that you can listen to:

```javascript
amqp.on('error', (error) => {
  console.error('Error:', error);
});

amqp.on('info', (info) => {
  console.log('Info:', info);
});

amqp.on('ready', (channel) => {
  console.log('Channel ready:', channel._id);
});

amqp.on('recreated', (channel) => {
  console.log('Channel re-created:', channel._id);
});

amqp.on('close', (info) => {
  console.log('Connection closed:', info);
});

amqp.on('channelMessage', (msg) => {
  console.log('Message received:', msg.content.toString());
});
```

### Health flag

`'ready'` fires once per channel, so a health flag needs both events to come back up:

```javascript
let healthy = false;
amqp.on('ready', () => { healthy = true; });
amqp.on('recreated', () => { healthy = true; });
amqp.on('close', () => { healthy = false; });
```

### Channel re-creates

When a channel or its connection closes, the pool re-creates the same `Channel` object on a
new amqplib channel.

- `'ready'` fires once per `Channel`, on its first create. Attaching `channel.on('message', ...)`
  inside a `'ready'` listener is safe: the listener runs once, so handlers do not stack up.
- `'recreated'` fires with the same `Channel` after each later re-create. Nothing needs to be
  done in it: a channel that was consuming (`autoConsume`, or `consume()` called once) resumes
  consuming on the new channel by itself, and its `'message'` listeners keep working.
  `consume()` is idempotent per amqplib channel, so calling it again is harmless.
- Messages that were unacked when the old channel closed are requeued by RabbitMQ and come
  back with `fields.redelivered === true`. Delivery tags belong to the channel that delivered
  them, so `ack()`/`nack()` of a message from the old channel is dropped (it would make
  RabbitMQ close the new channel with `406 PRECONDITION_FAILED unknown delivery tag`) and an
  `'info'` event is emitted instead:
  `{ message: 'stale ack dropped', messageId, channelId, reason }` (`'stale nack dropped'` for
  `nack()`). This holds for `channel.ack()`/`channel.nack()` and for `amqp.ack()`/`amqp.nack()`;
  the pool finds no channel for the old `channelId` and emits the same event.
  Handle the redelivered copy like any other message.
- `'ready'` and `'recreated'` are emitted only when the create succeeds, and only then does the
  channel re-consume.
- A failed create (for example a locked or missing queue, a missing exchange, a queue declare
  the broker refuses) leaves `alive` false and closes the failed amqplib channel. After each
  failed attempt the channel waits the current retry interval and tries again, while the
  connection is up. The interval starts at `reconnectInterval`, doubles after each consecutive
  failure up to `channelRetryMaxInterval` (default 30000 ms), and resets after a successful
  create. There is no cap on the number of attempts and only one retry is pending at a time;
  reading `alive` meanwhile does not start another create. While the connection is down,
  reading `alive` starts no create: the connection re-creates its channels when it reconnects.
  `close()` cancels a pending retry.

Before 3.0.0 `'ready'` fired on every re-create. Code that relied on that to call
`consume()` again keeps working, because the channel now re-consumes on its own.

`'channel is dead!'` and `'Message is null'` errors carry `{ message, channelId, queue, exchange }`,
and `'DELIVERY TAG NOT FOUND ...'` errors add `messageId`; none carries the `Channel` or the
connection URL.

## Graceful Shutdown

To properly close all connections and channels:

```javascript
await amqp.stop();
```

## Metrics

The client includes built-in metrics tracking:

- Connection success/error rates
- Message publish success rates
- Consumer success rates
- Channel and connection counts
- Reconnection attempts

These metrics are available through the @pm2/io integration.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and feature requests, please use the GitHub issues page.
```