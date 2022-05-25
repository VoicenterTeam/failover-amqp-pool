# failover-amqp-pool
amqp pool client

### Configuration
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
      "exchange_name": "TestExchange",
      "queue_name": "TestQueue",
      "prefetch": 5,
      "exchange_type": "fanout",
      "topic": "",
      "options": {}
    }
  },
  {
    "connection": {
      "host": "127.0.0.2",
      "port": 5672,
      "ssl": false,
      "username": "user",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5
    },
    "channel": {
      "exchange_name": "TestExchange",
      "queue_name": "TestQueue",
      "prefetch": 5,
      "exchange_type": "fanout",
      "topic": "",
      "options": {}
    }
  },
  {
    "connection": {
      "host": "127.0.0.3",
      "port": 5672,
      "ssl": false,
      "username": "user",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5
    },
    "channel": {
      "exchange_name": "TestExchange",
      "queue_name": "TestQueue",
      "prefetch": 5,
      "exchange_type": "fanout",
      "topic": "",
      "options": {}
    }
  },
  {
    "connection": {
      "host": "127.0.0.4",
      "port": 5672,
      "ssl": false,
      "username": "user",
      "password": "password",
      "vhost": "/",
      "heartbeat": 5

    },
    "channel": {
      "exchange_name": "TestExchange",
      "queue_name": "TestQueue",
      "prefetch": 5,
      "exchange_type": "fanout",
      "topic": "",
      "options": {}
    }
  }
]
```

### Usage
consume:
```js
let cfg = require('./config.json');
let Pool = require('./index');

let client = new Pool(cfg);

client.on('channel', (channel) => {
  channel.consume();
  channel.on('message', (message) => {
    console.log("Published ------ " + message.content.toString());
    client.ack(message);
  });
  client.createDynamicQueue("TestExchange",'createQueueTest',[{x:1,y:2},{x:11,y:22}]);
});
client.connect();
```

feed:
```js
let cfg = require('./config.json');
let Pool = require('@voicenter-team/failover-amqp-pool');

let client = new Pool(cfg);

client.on('channel', (channel) => {
  setInterval(() => {
    let msg = 'Hello World ' + Math.random();
    console.log("Publishing ------ " + msg);
    channel.publish(msg);
  }, 1000);
});

client.connect();
```
