// The same pool imported as a default under esModuleInterop.
import AMQPPool from '../..';

const pool = new AMQPPool([{
    connection: { host: 'localhost', port: 5672 },
    channel: { exchange: { name: 'events' } },
}]);
const conf: AMQPPool.ExchangeConf = { name: 'events' };
pool.on('ready', channel => { channel.sendToQueue('q', 'hi'); });
void conf;
void pool.stop().then(indexes => indexes.length);
