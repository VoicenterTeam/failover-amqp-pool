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
    password: 'guest',           // Password
    vhost: '/',                  // Virtual host
    heartbeat: 25,              // Heartbeat interval in seconds
    timeout: 5000,              // Connection timeout
    reconnectInterval: 1500     // Reconnection interval on failure
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

amqp.on('close', (info) => {
  console.log('Connection closed:', info);
});

amqp.on('channelMessage', (msg) => {
  console.log('Message received:', msg.content.toString());
});
```

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