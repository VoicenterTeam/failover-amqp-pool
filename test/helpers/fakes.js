// The amqplib channel the tests stand in for: records publishes and consumers, delivers on demand.
const { EventEmitter } = require('node:events');

class FakeAmqpChannel extends EventEmitter {
  constructor() {
    super();
    this.published = [];
    this.sent = [];
    this.consumers = [];
    this.tag = 0;
  }
  prefetch() { return Promise.resolve(); }
  checkExchange() { return Promise.resolve(); }
  checkQueue(queue) { return Promise.resolve({ queue }); }
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
  assertQueue(queue) { return Promise.resolve({ queue }); }
  bindQueue(queue, exchange, pattern) { this.bound = { queue, exchange, pattern }; return Promise.resolve(); }
}

module.exports = { FakeAmqpChannel };
