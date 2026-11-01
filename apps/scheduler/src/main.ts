// REQ-DISC-028 REQ-CORE-014 — scheduler entry point: loads PKI material, binds the mTLS listener and serves the
// Node API; counts every Node API request and serves /metrics, /healthz and /readyz on the plain-HTTP
// SCHEDULER_METRICS_PORT. `pnpm --filter @openmap/scheduler pki:init` creates a CA and scheduler certificate for a
// fresh single-node deployment.
import './instrumentation.js';
import { readFileSync } from 'node:fs';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { buildApp } from './server/app.js';
import { createJobStore } from './server/jobs.js';
import { loadCa } from './server/pki.js';
import { createResultsQueue } from './server/results-queue.js';
import { createOpenBaoReader } from './server/secrets.js';
import { TIME } from '@openmap/constants';
import { Counter, Histogram, createMetricsServer, createRegistry } from '@openmap/telemetry';

const MS_PER_SECOND = TIME.msPerSecond;

/** Prometheus metrics of the scheduler: Node API requests by route and status, and their duration. */
export function createSchedulerMetrics() {
  const registry = createRegistry();
  return {
    registry,
    requests: new Counter({ name: 'openmap_scheduler_requests_total', help: 'Node API requests served, by route and status', labelNames: ['route', 'status'], registers: [registry] }),
    duration: new Histogram({ name: 'openmap_scheduler_request_duration_seconds', help: 'Node API request duration', labelNames: ['route'], registers: [registry] }),
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const caPem = readFileSync(env.SCHEDULER_CA_CERT_PATH, 'utf8');
  const ca = await loadCa(caPem, readFileSync(env.SCHEDULER_CA_KEY_PATH, 'utf8'));
  const results = createResultsQueue(env);
  const app = buildApp({ env, prisma, jobs: createJobStore(prisma), results, secrets: createOpenBaoReader(env), ca, caPem });
  const metrics = createSchedulerMetrics();
  app.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions.url ?? req.url;
    metrics.requests.inc({ route, status: String(reply.statusCode) });
    metrics.duration.observe({ route }, reply.elapsedTime / MS_PER_SECOND);
    done();
  });
  const metricsServer = await createMetricsServer({
    registry: metrics.registry,
    port: env.SCHEDULER_METRICS_PORT,
    path: env.METRICS_PATH,
    ready: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
    log: (line) => console.log(JSON.stringify(line)),
  });
  // Fastify's https options: require a client certificate but let the enrolment route decide,
  // since a Node has no certificate yet when it enrols.
  const https = {
    key: readFileSync(env.SCHEDULER_TLS_KEY_PATH),
    cert: readFileSync(env.SCHEDULER_TLS_CERT_PATH),
    ca: caPem,
    requestCert: true,
    rejectUnauthorized: false,
  };
  const server = await import('node:https');
  const listener = server.createServer(https, (req, res) => {
    app.routing(req, res);
  });
  await app.ready();
  await new Promise<void>((resolve) => listener.listen(env.SCHEDULER_PORT, resolve));
  const shutdown = async (): Promise<void> => {
    await metricsServer.close();
    listener.close();
    await app.close();
    await results.close();
    await prisma.$disconnect();
  };
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
