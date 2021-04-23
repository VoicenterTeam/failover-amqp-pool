# failover-amqp-pool
amqp pool client

### Usage

It is important to set correct `directives` to make pool all queues and exchanges bind properly like `"directives": "ae,aq,qte"`.
- ae - assert exchang
- aq - assert queue
- qte - bind queue to exchange

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
        console.log('<< '+message.content.toString() + " -> " + i);
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

let pool = new AMQPPool(cfg);usage
pool.start();

setInterval(() => {
  pool.publish("Mesage-" + i, "rr");
  i++;
}, 1000);
```