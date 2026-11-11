let Transport = require('winston-transport');
let Pool = require('./index');

class WinstonAMQPPoolTransport extends Transport {
    // close() was called: the app asked for the stop, so lines drop with no warning
    #closed = false;
    // the stopped-pool warning went out; one per transport
    #warned = false;

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
    // Never throws, and calls back on every path
    log(info, callback) {
        try {
            if (!this.#closed) this.client.publish(this.#format(info), this.strategy, this.topic);
        } catch (e) {
            this.#failed(e);
        }
        callback();
    }
    // winston-transport calls it on unpipe, as logger.close() and logger.remove() do
    close() {
        this.#closed = true;
        this.client.stop().catch(() => {});
    }
    #format(info) {
        return this.useSymbol ? info[Symbol.for('message')] : JSON.stringify(info);
    }
    // A stopped pool warns once, then its lines drop; any other error is printed
    #failed(e) {
        if (e?.code !== 'POOL_STOPPED') return console.error(e);
        if (this.#warned) return;
        this.#warned = true;
        process.emitWarning('the pool is stopped: WinstonAMQPPoolTransport drops log lines',
            { code: 'POOL_STOPPED' });
        this.emit('warn', e);
    }
}

module.exports = WinstonAMQPPoolTransport;
