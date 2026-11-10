// A PRODUCER span per publish, its context written to the message headers, and a CONSUMER span
// per delivery around its 'message' listeners, parented on the context those headers carry.
// Names and attributes come from the pool's config, never from a message. Nothing here throws:
// an error from the publish or a listener passes on unchanged.
const {
  context,
  propagation,
  trace,
  ProxyTracerProvider,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
} = require('@opentelemetry/api');
const { ATTR, SCOPE } = require('./catalogue');
const { processAttributes, publishAttributes, thrownType } = require('./metrics');

// What this API copy's proxy provider delegates to while no SDK is set behind it.
const NO_SDK = new ProxyTracerProvider().getDelegate();

// Looked up per span and kept per global provider: an SDK set after load is picked up.
let current;

// Undefined while no SDK is set, or when the provider throws.
function currentTracer() {
  try {
    const provider = trace.getTracerProvider();
    if (provider.getDelegate?.() === NO_SDK) return undefined;
    if (current?.provider !== provider) {
      current = { provider, tracer: provider.getTracer(SCOPE.name, SCOPE.version) };
    }
    return current.tracer;
  } catch {
    return undefined;
  }
}

function start(tracer, name, kind, attributes, parent) {
  try {
    return tracer.startSpan(name, { kind, attributes }, parent);
  } catch {
    return undefined;
  }
}

// No status description: an error's text can quote a message.
function finish(span, error) {
  try {
    if (error !== undefined) {
      if (span.isRecording()) span.setAttribute(ATTR.errorType, thrownType(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  } catch {
    // Telemetry never fails a call.
  }
}

/**
 * Runs send(options) inside a PRODUCER span while a tracer SDK is set; send gets a copy of
 * options whose headers carry the span's context. The caller's options are never changed, so a
 * channel's default options keep no trace header. With no SDK, send(options) runs bare.
 */
function publishing(url, exchange, options, send) {
  const tracer = currentTracer();
  if (!tracer) return send(options);
  const attributes = publishAttributes(url, exchange);
  const span = start(tracer, `publish ${attributes[ATTR.destination]}`, SpanKind.PRODUCER, attributes);
  if (!span) return send(options);
  let withContext = options;
  try {
    const headers = { ...options?.headers };
    propagation.inject(trace.setSpan(context.active(), span), headers);
    withContext = { ...options, headers };
  } catch {
    withContext = options;
  }
  let result;
  try {
    result = send(withContext);
  } catch (error) {
    finish(span, error);
    throw error;
  }
  finish(span);
  return result;
}

/**
 * Runs a delivery's listeners inside a CONSUMER span while a tracer SDK is set, active for
 * their synchronous part. The parent is the context in the message headers, else none.
 */
function processing(url, queue, msg, run) {
  const tracer = currentTracer();
  if (!tracer) return run();
  let span;
  let active;
  try {
    const parent = propagation.extract(ROOT_CONTEXT, msg?.properties?.headers || {});
    const attributes = processAttributes(url, queue);
    const name = `process ${attributes[ATTR.destination] ?? '(temporary)'}`;
    span = start(tracer, name, SpanKind.CONSUMER, attributes, parent);
    if (span) active = trace.setSpan(parent, span);
  } catch {
    span = undefined;
  }
  if (!span) return run();
  let ran = false;
  let returned = false;
  let result;
  try {
    context.with(active, () => {
      ran = true;
      result = run();
      returned = true;
    });
  } catch (error) {
    // The context manager failed, not a listener: the listeners run once, and its error is not
    // passed on.
    if (!ran) {
      finish(span);
      return run();
    }
    if (!returned) {
      finish(span, error);
      throw error;
    }
  }
  finish(span);
  return result;
}

module.exports = { publishing, processing };
