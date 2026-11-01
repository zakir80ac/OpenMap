// REQ-CORE-014 — observability shared by every service: the OpenTelemetry SDK (spans always recorded in-process,
// exported over OTLP/HTTP only when OTEL_EXPORTER_OTLP_ENDPOINT is set, so an air-gapped deployment makes no calls),
// a Prometheus registry served on a plain HTTP port together with liveness and readiness, and a span helper for the
// units of work the headless services perform (a reconciled result, an outbox batch, a BSM recompute).
import { createServer, type Server } from 'node:http';
import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { Env } from '@openmap/config';
import { HTTP } from '@openmap/constants';
import { Registry, collectDefaultMetrics } from 'prom-client';

export { Counter, Gauge, Histogram, Registry } from 'prom-client';

export function startTelemetry(serviceName: string, env: Pick<Env, 'OTEL_EXPORTER_OTLP_ENDPOINT'>): NodeSDK {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const exporter = endpoint.length > 0 ? new OTLPTraceExporter({ url: new URL('v1/traces', endpoint.endsWith('/') ? endpoint : endpoint + '/').toString() }) : undefined;
  const sdk = new NodeSDK({ serviceName, instrumentations: [getNodeAutoInstrumentations()], ...(exporter ? { traceExporter: exporter } : {}) });
  sdk.start();
  return sdk;
}

/** A registry with the Node runtime metrics already attached; services add their own counters to it. */
export function createRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return registry;
}

export interface MetricsServerOptions {
  registry: Registry;
  port: number;
  /** Path the scraper reads, from METRICS_PATH. */
  path: string;
  /** Readiness check; a rejection or `false` answers 503 on /readyz. */
  ready?: () => Promise<boolean>;
  log?: (line: Record<string, unknown>) => void;
}

export interface MetricsServer {
  close(): Promise<void>;
  port: number;
}

const HEALTHZ = '/healthz';
const READYZ = '/readyz';

/** Serves the registry, liveness and readiness on a plain HTTP listener bound to every interface. */
export async function createMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === options.path) {
      void options.registry.metrics().then(
        (body) => {
          res.writeHead(HTTP.status.ok, { 'content-type': options.registry.contentType });
          res.end(body);
        },
        (err: unknown) => {
          res.writeHead(HTTP.status.internalError, { 'content-type': 'text/plain' });
          res.end(err instanceof Error ? err.message : String(err));
        },
      );
      return;
    }
    if (url === HEALTHZ) {
      res.writeHead(HTTP.status.ok, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url === READYZ) {
      const check = options.ready ?? (() => Promise.resolve(true));
      void check().then(
        (ok) => {
          res.writeHead(ok ? HTTP.status.ok : HTTP.status.serviceUnavailable, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: ok ? 'ready' : 'not ready' }));
        },
        (err: unknown) => {
          res.writeHead(HTTP.status.serviceUnavailable, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'not ready', error: err instanceof Error ? err.message : String(err) }));
        },
      );
      return;
    }
    res.writeHead(HTTP.status.notFound, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  options.log?.({ msg: 'metrics listening', port, path: options.path });
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Runs `fn` inside a span named `name`, records the error and re-throws, so every unit of work is traced the same way. */
export async function withSpan<T>(tracerName: string, name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = trace.getTracer(tracerName);
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
