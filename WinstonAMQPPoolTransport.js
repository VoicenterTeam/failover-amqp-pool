let Transport = require('winston-transport');
let Pool = require('./index');

class WinstonAMQPPoolTransport extends Transport {
    constructor(opts) {
        super(opts);
        this.strategy = opts.strategy || 'all';
        this.topic = opts.topic || '';
        this.client = new Pool(opts.pool);
        this.useSymbol = opts.useSymbol;
        this.client.on('error', (err) => {
            //
        })
        this.client.start();

    }
    log(info, callback) {
        let message;
        if(this.useSymbol){
            message = info[Symbol.for('message')];
        }else{
            message = JSON.stringify(info)
        }
            
        try {
            this.client.publish(message, this.strategy, this.topic);
        }catch (e) {
            console.error(e)
        }
        callback();
    }
}

module.exports = WinstonAMQPPoolTransport;