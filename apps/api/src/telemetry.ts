// REQ-CORE-012 — OpenTelemetry SDK. Spans are always recorded in-process; the OTLP/HTTP exporter is
// attached only when OTEL_EXPORTER_OTLP_ENDPOINT is set, so an air-gapped deployment makes no calls.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { Env } from '@openmap/config';

export const SERVICE_NAME = 'openmap-api';

export function startTelemetry(env: Pick<Env, 'OTEL_EXPORTER_OTLP_ENDPOINT'>): NodeSDK {
  const exporter = env.OTEL_EXPORTER_OTLP_ENDPOINT.length > 0 ? new OTLPTraceExporter({ url: new URL('v1/traces', env.OTEL_EXPORTER_OTLP_ENDPOINT.endsWith('/') ? env.OTEL_EXPORTER_OTLP_ENDPOINT : env.OTEL_EXPORTER_OTLP_ENDPOINT + '/').toString() }) : undefined;
  const sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    instrumentations: [getNodeAutoInstrumentations()],
    ...(exporter ? { traceExporter: exporter } : {}),
  });
  sdk.start();
  return sdk;
}
