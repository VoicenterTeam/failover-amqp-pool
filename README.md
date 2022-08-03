# failover-amqp-pool

amqp pool client

### Usage
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
      "exchange": {
        "name": "TestExchange",
        "type": "fanout",
        "options": {
          "durable": true
        }
      },
      "queue": {
        "name": "TestQueue",
        "options": {
          "exclusive": false,
          "durable": true
        }
      },
      "binding":  {
        "enabled": true,
        "pattern": "routing_key",
        "options": {}
      },
      "prefetch": 5
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
      "exchange": {
        "name": "TestExchange2",
        "type": "fanout",
        "options": {
          "durable": true
        }
      },
      "queue": {
        "name": "TestQueue2",
        "options": {
          "exclusive": false,
          "durable": true
        }
      },
      "binding":  {
        "enabled": true,
        "pattern": "",
        "options": {}
      },
      "prefetch": 5
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
      "exchange": {
        "name": "TestExchange3",
        "type": "fanout",
        "options": {
          "durable": true
        }
      },
      "queue": {
        "name": "TestQueue3",
        "options": {
          "exclusive": false,
          "durable": true
        }
      },
      "binding":  {
        "enabled": true,
        "pattern": "routing_key",
        "options": {}
      },
      "prefetch": 5
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
      "exchange": {
        "name": "TestExchange4",
        "type": "fanout",
        "options": {
          "durable": true
        }
      },
      "queue": {
        "name": "TestQueue4",
        "options": {
          "exclusive": false,
          "durable": true
        }
      },
      "binding":  {
        "enabled": true,
        "pattern": "routing_key",
        "options": {}
      },
      "prefetch": 5
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
      "exchange": {
        "name": "TestExchange",
        "type": "fanout",
        "options": {
          "durable": true
        }
      }
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
      "exchange": {
        "name": "TestExchange1",
        "type": "fanout",
        "options": {
          "durable": true
        }
      }
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
      "exchange": {
        "name": "TestExchange2",
        "type": "fanout",
        "options": {
          "durable": true
        }
      }
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
      "exchange": {
        "name": "TestExchange3",
        "type": "fanout",
        "options": {
          "durable": true
        }
      }
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
    pool.publish("Mesage-" + i, 'rr', "pattern", {"headers": {"asd": "asd"}});
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
const winston = require('winston');
const WinstonAMQPPoolTransport = require("./WinstonAMQPPoolTransport.js");

const logger = winston.createLogger({
level: 'info',
format: winston.format.json(),
defaultMeta: {service: 'user-service'},
transports: [
new WinstonAMQPPoolTransport({
    filename: 'error.log',
    level: 'error',
    pool: [{
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
            "exchange": {
                "name": "TestExchange",
                "type": "fanout",
                "options": {
                    "durable": true
                }
            }
        }
    }],
    strategy: 'all',
    topic: ""
});

setInterval(() => {
    console.log(1)
    logger.log( 'error', 'asdasdsadsad');
}, 1000);
```