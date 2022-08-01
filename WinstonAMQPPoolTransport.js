let Transport = require('winston-transport');
let Pool = require('./index');

class WinstonAMQPPoolTransport extends Transport {
    constructor(opts) {
        super(opts);
        this.strategy = opts.strategy || 'all';
        this.topic = opts.topic || '';
        this.channel = {};
        this.client = new Pool(opts.pool);
        this.client.on('ready', (channel) => {
            this.channel = channel;
        });
        this.client.start();

    }
    log(info, callback) {
        try {
            if(this.channel?.publish)
                this.channel.publish(JSON.stringify(info), this.strategy, this.topic);
        }catch (e) {
            console.error(e)
        }
        callback();
    }
}

module.exports = WinstonAMQPPoolTransport;