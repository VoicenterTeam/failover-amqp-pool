/**
 * Metrics module for failover-amqp-pool
 * 
 * Supports both Node.js (@pm2/io) and Bun (with external metrics provider)
 * 
 * Usage options:
 * 1. External metrics provider (recommended for Bun):
 *    - Call Metrics.setExternalProvider(metricsMonitor) before creating AMQPPool
 *    - The provider should have: createCounter, createGauge, createMeter methods
 * 
 * 2. Built-in @pm2/io (Node.js):
 *    - Automatic if no external provider is set
 * 
 * Runtime detection is automatic, or can be forced via:
 * - Environment variable: AMQP_POOL_RUNTIME='bun' or 'node'
 */

// Detect runtime
const isBunRuntime = typeof Bun !== 'undefined' || !!process.versions?.bun;
const forceRuntime = process.env.AMQP_POOL_RUNTIME?.toLowerCase();

// Determine which runtime to use
function shouldUseBun() {
    if (forceRuntime === 'bun') return true;
    if (forceRuntime === 'node') return false;
    return isBunRuntime;
}

// Library instances (lazy loaded)
let probe = null;           // @pm2/io
let externalProvider = null; // External metrics provider (e.g., MetricsMonitor)

// Track loaded library
let loadedLibrary = null;   // 'pm2io' | 'external' | 'fallback'

// Local metrics cache
const metricsCache = new Map();

/**
 * Try to load @pm2/io
 */
function loadPm2Io() {
    try {
        probe = require('@pm2/io');
        loadedLibrary = 'pm2io';
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Initialize libraries based on runtime and external provider
 */
function initializeLibrary() {
    if (loadedLibrary) return; // Already initialized
    
    // If external provider is set, use it
    if (externalProvider) {
        loadedLibrary = 'external';
        console.log('[AMQP_POOL_METRICS] Using external metrics provider');
        return;
    }
    
    const useBun = shouldUseBun();
    
    if (useBun) {
        // Bun mode - use fallback (external provider should be set)
        loadedLibrary = 'fallback';
        console.log('[AMQP_POOL_METRICS] Bun runtime detected - use Metrics.setExternalProvider() for metrics push');
    } else {
        // Node.js mode - try pm2/io first
        if (!loadPm2Io()) {
            loadedLibrary = 'fallback';
            console.log('[AMQP_POOL_METRICS] No metrics library available, using fallback');
        }
    }
}

/**
 * Create a metric using external provider
 */
function createExternalMetric(options, provider) {
    const type = options.type;
    const name = options.name;
    
    try {
        switch (type) {
            case 'gauge':
                return provider.createGauge(name, options.unit || 'count');
            case 'counter':
                return provider.createCounter(name, options.unit || 'count');
            case 'meter':
                return provider.createMeter(name, options);
            default:
                return createFallbackMetric(options);
        }
    } catch (e) {
        console.error('[AMQP_POOL_METRICS] Error creating external metric:', e.message);
        return createFallbackMetric(options);
    }
}

/**
 * Create a fallback metric (no-op with local tracking)
 */
function createFallbackMetric(options) {
    const type = options.type;
    const name = options.name;
    
    switch (type) {
        case 'gauge':
            const gauge = {
                _value: 0,
                _valueFn: typeof options.value === 'function' ? options.value : null,
                _name: name,
                _interval: null,
                
                set(val) { 
                    this._value = val; 
                    this._valueFn = null;
                },
                
                val() { 
                    return this._valueFn ? this._valueFn() : this._value; 
                }
            };
            
            // If value function provided, poll it periodically
            if (gauge._valueFn) {
                try {
                    gauge._value = gauge._valueFn();
                } catch (e) {}
                
                gauge._interval = setInterval(() => {
                    try {
                        gauge._value = gauge._valueFn();
                    } catch (e) {}
                }, 2000);
            }
            
            return gauge;
            
        case 'counter':
            return {
                _value: 0,
                _name: name,
                
                inc(val = 1) { 
                    this._value += val;
                },
                
                val() { 
                    return this._value; 
                }
            };
            
        case 'meter':
            return {
                _count: 0,
                _startTime: Date.now(),
                _name: name,
                
                mark(val = 1) { 
                    if (val === false) return;
                    this._count += (typeof val === 'number' ? val : 1);
                },
                
                val() {
                    const elapsed = (Date.now() - this._startTime) / 1000;
                    return elapsed > 0 ? this._count / elapsed : 0;
                }
            };
            
        default:
            return { 
                val() { return 0; }, 
                set() {}, 
                inc() {}, 
                mark() {} 
            };
    }
}

/**
 * Create metric using @pm2/io
 */
function createPm2Metric(metricOptions) {
    // Check if metric already exists
    let metric = probe.metricService?.metrics?.get(metricOptions.name);
    if (metric) {
        return metric.implementation || metric;
    }
    
    // Create new metric
    metric = probe[metricOptions.type](metricOptions);
    return metric;
}

/**
 * Metrics class - main export
 * Maintains backward compatibility with existing API
 */
class Metrics {
    constructor(node = 'AMQP_POOL') {
        this.group = 'AMQP_POOL';
        this.node = node;
        
        // Initialize library on first Metrics instance
        initializeLibrary();
    }
    
    /**
     * Create or get a metric
     * @param {Object} options - Metric options
     * @param {string} options.type - 'gauge', 'counter', or 'meter'
     * @param {string} options.name - Metric name
     * @param {string} [options.node] - Override node name
     * @param {Function} [options.value] - Value function for gauges
     * @param {number} [options.samples] - For meters
     * @param {number} [options.timeframe] - For meters
     * @returns {Object} Metric with .mark(), .inc(), .set(), .val() methods
     */
    metric(options) {
        const metricOptions = Object.assign({}, options);
        
        // Build metric name with prefix
        let prefix = '';
        if (options.node || this.node) {
            prefix = `[${this.group}] [${options.node || this.node}]`;
        }
        metricOptions.name = prefix + options.name;
        
        // Check cache first
        if (metricsCache.has(metricOptions.name)) {
            return metricsCache.get(metricOptions.name);
        }
        
        let metric;
        
        // Create metric based on loaded library
        if (loadedLibrary === 'external' && externalProvider) {
            metric = createExternalMetric(metricOptions, externalProvider);
        } else if (loadedLibrary === 'pm2io') {
            metric = createPm2Metric(metricOptions);
        } else {
            metric = createFallbackMetric(metricOptions);
        }
        
        // Cache and return
        metricsCache.set(metricOptions.name, metric);
        return metric;
    }
}

/**
 * Set an external metrics provider
 * Call this BEFORE creating AMQPPool instances
 * 
 * @param {Object} provider - Metrics provider with createCounter, createGauge, createMeter methods
 */
Metrics.setExternalProvider = function(provider) {
    if (!provider) {
        console.warn('[AMQP_POOL_METRICS] setExternalProvider called with null/undefined');
        return;
    }
    
    // Validate provider has required methods
    const requiredMethods = ['createCounter', 'createGauge', 'createMeter'];
    const missingMethods = requiredMethods.filter(m => typeof provider[m] !== 'function');
    
    if (missingMethods.length > 0) {
        console.warn(`[AMQP_POOL_METRICS] External provider missing methods: ${missingMethods.join(', ')}`);
    }
    
    externalProvider = provider;
    loadedLibrary = 'external';
    console.log('[AMQP_POOL_METRICS] External metrics provider set');
};

/**
 * Get the current external provider
 */
Metrics.getExternalProvider = function() {
    return externalProvider;
};

// Static properties for debugging/introspection
Metrics.isBunRuntime = isBunRuntime;
Metrics.getLoadedLibrary = () => loadedLibrary;
Metrics.hasExternalProvider = () => !!externalProvider;

module.exports = Metrics;
