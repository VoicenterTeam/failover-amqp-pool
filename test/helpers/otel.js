// An OpenTelemetry SDK for tests, as vc-dal's test/helpers/otel.ts: started only when a test
// asks, so a file can load the pool first. Spans go to an in-memory exporter; each
// startMetrics(t) sets a new meter provider, whose points the test collects by hand, and
// removes it once the test ends.
const api = require('@opentelemetry/api');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');
const { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } = require('@opentelemetry/sdk-trace');
const { MeterProvider, MetricReader } = require('@opentelemetry/sdk-metrics');

let exporter;
let provider;

// The global tracer provider and propagator are set once and kept by every test of the file.
function startTracing() {
  if (!provider) {
    exporter = new InMemorySpanExporter();
    api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    api.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    api.trace.setGlobalTracerProvider(provider);
  }
  exporter.reset();
  const spans = async () => (await provider.forceFlush(), exporter.getFinishedSpans());
  return { spans };
}

class Reader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}

// A fresh meter provider: the pool must notice the new one, and points start from zero.
function startMetrics(t) {
  api.metrics.disable();
  const reader = new Reader();
  api.metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  t.after(() => api.metrics.disable());
  const metrics = async () => {
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics.flatMap(scope =>
      scope.metrics.map(metric => ({ scope: scope.scope, ...metric })));
  };
  const points = async name =>
    (await metrics()).filter(m => m.descriptor.name === name).flatMap(m => m.dataPoints);
  return { metrics, points };
}

module.exports = { startTracing, startMetrics };
