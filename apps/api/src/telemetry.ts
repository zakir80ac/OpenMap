// REQ-CORE-012 REQ-CORE-014 — OpenTelemetry SDK for the API, through the shared telemetry package (spans always
// recorded in-process; OTLP export only when OTEL_EXPORTER_OTLP_ENDPOINT is set, so an air-gapped deployment makes
// no calls).
import type { NodeSDK } from '@opentelemetry/sdk-node';
import type { Env } from '@openmap/config';
import { startTelemetry as start } from '@openmap/telemetry';

export const SERVICE_NAME = 'openmap-api';

export function startTelemetry(env: Pick<Env, 'OTEL_EXPORTER_OTLP_ENDPOINT'>): NodeSDK {
  return start(SERVICE_NAME, env);
}
