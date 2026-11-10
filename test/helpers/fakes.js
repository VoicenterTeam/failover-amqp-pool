// The amqplib channel the tests stand in for: records publishes and consumers, delivers on demand.
const { EventEmitter } = require('node:events');

class FakeAmqpChannel extends EventEmitter {
  constructor() {
    super();
    this.published = [];
    this.sent = [];
    this.consumers = [];
    this.tag = 0;
    this.queues = new Set();   // queues the fake knows, for strictQueues
    this.strictQueues = false; // true: checkQueue of an unknown name rejects {code: 404}
  }
  prefetch() { return Promise.resolve(); }
  checkExchange() { return Promise.resolve(); }
  checkQueue(queue) {
    if (this.strictQueues && !this.queues.has(queue)) {
      return Promise.reject(Object.assign(new Error('NOT_FOUND'), { code: 404 }));
    }
    return Promise.resolve({ queue });
  }
  consume(queue, cb, opts) { this.consumers.push(cb); return Promise.resolve({ consumerTag: opts.consumerTag }); }
  publish(exchange, routingKey, content, options) {
    if (this.publishError) throw this.publishError;
    this.published.push({ exchange, routingKey, options });
    return true;
  }
  sendToQueue(queue, content, ...rest) { this.sent.push({ queue, content, rest }); return true; }
  ack() {}
  nack() {}
  close() { this.emit('close'); }
  deliver(body, headers) {
    const m = { content: Buffer.from(body), fields: { deliveryTag: ++this.tag }, properties: { headers } };
    this.consumers.forEach(cb => cb(m));
    return m;
  }
  // appended for the dynamic-queue tests
  assertQueue(queue, options) {
    this.queues.add(queue);
    this.asserted = { queue, options };
    return Promise.resolve({ queue });
  }
  bindQueue(queue, exchange, pattern) {
    this.bound = { queue, exchange, pattern };
    return Promise.resolve();
  }
}

module.exports = { FakeAmqpChannel };
