// REQ-DISC-028 — scheduler entry point: loads PKI material, binds the mTLS listener and serves the
// Node API. `pnpm --filter @openmap/scheduler pki:init` creates a CA and scheduler certificate
// for a fresh single-node deployment.
import { readFileSync } from 'node:fs';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { buildApp } from './server/app.js';
import { createJobStore } from './server/jobs.js';
import { loadCa } from './server/pki.js';
import { createResultsQueue } from './server/results-queue.js';
import { createOpenBaoReader } from './server/secrets.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const caPem = readFileSync(env.SCHEDULER_CA_CERT_PATH, 'utf8');
  const ca = await loadCa(caPem, readFileSync(env.SCHEDULER_CA_KEY_PATH, 'utf8'));
  const results = createResultsQueue(env);
  const app = buildApp({ env, prisma, jobs: createJobStore(prisma), results, secrets: createOpenBaoReader(env), ca, caPem });
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
