# failover-amqp-pool

amqp pool client

### Usage

It is important to set correct `directives` to make pool all queues and exchanges bind properly
like `"directives": "ae,aq,qte"`.

- ae - assert exchang
- aq - assert queue
- qte - bind queue to exchange

Publishing strategies:

- "rr" - round robin (for all available channels)
- "all" - to all available channels
- function(msg, channels) {} - callback

### Consume

config:

```json
[
  {
    "connection": {
      "host": "127.0.0.1",
      "port": 5672,
      "ssl": false,
      "username": "user",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5
    },
    "channel": {
      "directives": "ae,aq,qte",
      "exchange_name": "TestE",
      "exchange_type": "fanout",
      "exchange_durable": true,
      "queue_name": "TestQ",
      "queue_durable": true,
      "queue_exclusive": false,
      "prefetch": 5,
      "topic": "",
      "options": {}
    }
  },
  {
    "connection": {
      "host": "127.0.0.1",
      "port": 5672,
      "ssl": false,
      "username": "test",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5
    },
    "channel": {
      "directives": "ae,aq,qte",
      "exchange_name": "TestExchange",
      "exchange_type": "fanout",
      "exchange_durable": true,
      "queue_name": "TestQueue",
      "queue_durable": true,
      "queue_exclusive": false,
      "prefetch": 5,
      "topic": "",
      "options": {}
    }
  },
  {
    "connection": {
      "host": "127.0.0.1",
      "port": 5672,
      "ssl": false,
      "username": "test",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5
    },
    "channel": {
      "directives": "ae,aq,qte",
      "exchange_name": "TestExchange1",
      "exchange_type": "fanout",
      "exchange_durable": true,
      "queue_name": "TestQueue1",
      "queue_durable": true,
      "queue_exclusive": false,
      "prefetch": 5,
      "topic": "",
      "options": {}
    }
  },
  {
    "connection": {
      "host": "127.0.0.1",
      "port": 5672,
      "ssl": false,
      "username": "test",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5
    },
    "channel": {
      "directives": "ae,aq,qte",
      "exchange_name": "TestExchange2",
      "exchange_type": "fanout",
      "exchange_durable": true,
      "queue_name": "TestQueue2",
      "queue_durable": true,
      "queue_exclusive": false,
      "prefetch": 5,
      "topic": "",
      "options": {}
    }
  }
]
```

code:

```js
let cfg = require('./config1.json');
const AMQPPool = require('./index');
let i = 0;
let pool = new AMQPPool(cfg);
pool.start();
pool.on('ready', (_channel) => {
    (function (channel) {
        channel.on("message", (message) => {
            setTimeout(() => {
                console.log('<< ' + message.content.toString() + " -> " + i);
                channel.ack(message);
                i++;
            }, 500);
        });
        channel.consume();
    })(_channel);
});
```

### Feed

config:

```json
[
  {
    "connection": {
      "host": "127.0.0.1",
      "port": 5672,
      "ssl": false,
      "username": "user",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5
    },
    "channel": {
      "directives": "ae",
      "exchange_name": "TestE",
      "exchange_type": "fanout",
      "exchange_durable": true,
      "topic": "",
      "options": {}
    }
  },
  {
    "connection": {
      "host": "127.0.0.1",
      "port": 5672,
      "ssl": false,
      "username": "test",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5
    },
    "channel": {
      "directives": "ae",
      "exchange_name": "TestExchange",
      "exchange_type": "fanout",
      "exchange_durable": true,
      "topic": "",
      "options": {}
    }
  },
  {
    "connection": {
      "host": "127.0.0.1",
      "port": 5672,
      "ssl": false,
      "username": "test",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5
    },
    "channel": {
      "directives": "ae",
      "exchange_name": "TestExchange1",
      "exchange_type": "fanout",
      "exchange_durable": true,
      "topic": "",
      "options": {}
    }
  },
  {
    "connection": {
      "host": "127.0.0.1",
      "port": 5672,
      "ssl": false,
      "username": "test",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5
    },
    "channel": {
      "directives": "ae",
      "exchange_name": "TestExchange2",
      "exchange_type": "fanout",
      "exchange_durable": true,
      "topic": "",
      "options": {}
    }
  }
]
```

code:

```js
let cfg = require('./config.json');
const AMQPPool = require('./index');
let i = 0;

let pool = new AMQPPool(cfg);
pool.start();

// Publish a message rr with internal counter
setInterval(() => {
    pool.publish("Mesage-" + i, "rr");
    i++;
}, 1000);

// Publish a message with a callback which implements rr
let rr_i = 0;
setInterval(() => {
    pool.publish("Mesage-" + i, function (channels) {
        if (rr_i >= channels.length) {
            rr_i = 0;
        }
        return channels[rr_i++];
    });
    i++;
}, 1000);

// Publish a message to all available channels
pool.on('ready', (_channel) => {
    (function (channel) {
        setInterval(() => {
            channel.publish("Mesage-" + i, "all");
            console.log("Mesage-" + i);
            i++;
        }, 1000);
    })(_channel);
});
```

###Transport

```json
cconst winston = require('winston');
const WinstonAMQPPoolTransport = require("./WinstonAMQPPoolTransport.js");

const logger = winston.createLogger({
level: 'info',
format: winston.format.json(),
defaultMeta: {service: 'user-service'},
transports: [
new WinstonAMQPPoolTransport({
    filename: 'error.log',
    level: 'error',
    amqpPool: {
        lines: [{
            "connection": {
                "host": "127.0.0.1",
                "port": 5672,
                "ssl": false,
                "username": "user",
                "password": "password",
                "vhost": "/",
                "heartbeat": 5,
                "reconnectInterval": 2000
            },
            "channel": {
                "directives": "ae",
                "exchange_name": "TestE",
                "exchange_type": "fanout",
                "exchange_durable": true,
                "topic": "",
                "reconnectInterval": 2000
            }
        }],
        strategy: 'all',
        topic: ""
    }
});

setInterval(() => {
    console.log(1)
    logger.log( 'error', 'asdasdsadsad');
}, 1000);
```