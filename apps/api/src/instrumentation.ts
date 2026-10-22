// REQ-CORE-012 — process instrumentation. Imported first by main.ts so the SDK and the ESM loader hook
// are in place before Nest, Fastify, Prisma and the Bolt driver are loaded.
import { register } from 'node:module';
import { loadEnv } from '@openmap/config';
import { startTelemetry } from './telemetry.js';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

export const telemetry = startTelemetry(loadEnv());

const shutdown = (): void => {
  void telemetry.shutdown().finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
