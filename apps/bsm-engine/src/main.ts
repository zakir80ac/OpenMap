// REQ-BSM-001 REQ-BSM-002 — BSM engine service: consumes the event stream the reconciler publishes,
// applies CI health, recomputes services per tenant after a short debounce, and re-evaluates every
// known tenant on a timer so stale CIs and expiring certificates surface without new events.
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { BSM, RECONCILER } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { eventEnvelopeSchema } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { createOpenBaoReader } from './service/openbao.js';
import { createEngine } from './service/engine.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const graph = createGraphRepository(env);
  await graph.ensureSchema();
  const log = (line: Record<string, unknown>): void => console.log(JSON.stringify(line));
  const engine = createEngine({
    prisma, graph, secrets: createOpenBaoReader(env), now: () => new Date().toISOString(), log,
    delivery: { fetchImpl: fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date().toISOString() },
  });
  const pending = new Map<string, NodeJS.Timeout>();
  const known = new Set<string>((await prisma.tenant.findMany({ select: { id: true } })).map((t) => t.id));
  const recompute = async (tenantId: string): Promise<void> => {
    try {
      const report = await engine.recomputeTenant(tenantId);
      if (report.changed > 0) log({ msg: 'services recomputed', ...report });
    } catch (err) {
      log({ msg: 'recompute failed', tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const schedule = (tenantId: string): void => {
    known.add(tenantId);
    const existing = pending.get(tenantId);
    if (existing) clearTimeout(existing);
    pending.set(tenantId, setTimeout(() => {
      pending.delete(tenantId);
      void recompute(tenantId);
    }, BSM.recomputeDebounceMs));
  };
  const connection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const worker = new Worker(
    RECONCILER.eventStreamQueue,
    async (job) => {
      const e = eventEnvelopeSchema.parse(job.data);
      const report = await engine.applyCiEvents([e]);
      for (const tenantId of report.tenants) schedule(tenantId);
      return report;
    },
    { connection, concurrency: RECONCILER.resultsConcurrency },
  );
  const tick = setInterval(() => {
    for (const tenantId of known) void recompute(tenantId);
  }, BSM.tickMs);
  const shutdown = async (): Promise<void> => {
    clearInterval(tick);
    for (const t of pending.values()) clearTimeout(t);
    await worker.close();
    await graph.close();
    await prisma.$disconnect();
    await connection.quit();
  };
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  for (const tenantId of known) void recompute(tenantId);
  log({ msg: 'bsm engine started', queue: RECONCILER.eventStreamQueue, tenants: known.size, tickMs: BSM.tickMs });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
