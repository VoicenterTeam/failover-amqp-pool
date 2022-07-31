let Transport = require('winston-transport');
let Pool = require('./index');

class WinstonAMQPPoolTransport extends Transport {
    constructor(opts) {
        super(opts.winstonConfig);
        this.channel = {};
        this.client = new Pool(opts.amqp);
        this.client.on('ready', (channel) => {
            this.channel = channel;
        });
        this.client.start();

    }
    log(info, callback) {
        try {
            if(this.channel?.publish)
                this.channel.publish(JSON.stringify(info));
        }catch (e) {
            console.error(e)
        }
        callback();
    }
}

module.exports = WinstonAMQPPoolTransport;