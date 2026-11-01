// REQ-CORE-014 — process instrumentation, imported first by main.ts so the OpenTelemetry SDK and the ESM loader hook
// are in place before BullMQ, Prisma, the Bolt driver and the HTTP clients are loaded.
import { register } from 'node:module';
import { loadEnv } from '@openmap/config';
import { startTelemetry } from '@openmap/telemetry';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

export const telemetry = startTelemetry('openmap-bsm-engine', loadEnv());
