const probe = require('@pm2/io');

class Metrics{
    constructor(node = 'AMQP_POOL'){
        this.group = 'AMQP_POOL'
        this.node = node
    }
    metric(options){
        const metricOptions = Object.assign({}, options)
        let prefix = ''
        if(options.node || this.node) prefix = `[${this.group}] [${options.node || this.node}]`
        metricOptions.name = prefix + options.name
         
        let metric = probe.metricService.metrics.get(metricOptions.name)
        if(!metric){
            metric = probe[options.type](metricOptions)
            return metric
        }  
        return metric.implementation
    }
}

module.exports = Metrics