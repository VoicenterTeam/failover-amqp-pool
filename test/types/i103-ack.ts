// #103: Channel.ack() and Channel.nack() return boolean. test/i103-ack-types.test.js compiles
// this file; against a void declaration the two assignments below fail with TS2322.
import AMQPPool = require('../..');
import type { ConsumeMessage } from 'amqplib';

declare const channel: AMQPPool.Channel;
declare const msg: ConsumeMessage;

const acked: boolean = channel.ack(msg);
const nacked: boolean = channel.nack(msg);
if (!acked || !nacked) console.log('dropped', msg.properties.messageId);
