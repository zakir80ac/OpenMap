// REQ-CORE-013 REQ-CORE-005 — reconciler service: BullMQ worker over collector results plus the
// outbox dispatcher loop. Both stop cleanly on SIGINT/SIGTERM.
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { RECONCILER } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { collectorResultSchema } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { createClickHouse, createEventStream, createMeilisearchSink, dispatchOnce } from './worker/dispatcher.js';
import { processResult, retryPendingRelationships } from './worker/pipeline.js';

const RESULTS_QUEUE = RECONCILER.resultsQueue;

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const graph = createGraphRepository(env);
  await graph.ensureSchema();
  const sinks = { graph, clickhouse: createClickHouse(env), search: createMeilisearchSink(env), stream: createEventStream(env) };
  const connection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const worker = new Worker(
    RESULTS_QUEUE,
    async (job) => {
      const result = collectorResultSchema.parse(job.data);
      const summary = await processResult(prisma, result);
      const retried = await retryPendingRelationships(prisma, result.tenantId);
      console.log(JSON.stringify({ msg: 'reconciled', runId: result.runId, collector: result.collectorId, ...summary, pendingResolved: retried.resolved }));
      return summary;
    },
    { connection, concurrency: RECONCILER.resultsConcurrency },
  );
  let running = true;
  const loop = (async () => {
    while (running) {
      const report = await dispatchOnce(prisma, sinks, env.CLICKHOUSE_DB);
      if (report.failures.length) console.error(JSON.stringify({ msg: 'outbox failures', ...report }));
      if (report.claimed === 0) await new Promise((r) => setTimeout(r, RECONCILER.outboxIdleMs));
    }
  })();
  const shutdown = async (): Promise<void> => {
    running = false;
    await worker.close();
    await loop;
    await sinks.stream.close();
    await sinks.clickhouse.close();
    await graph.close();
    await prisma.$disconnect();
    await connection.quit();
  };
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  console.log(JSON.stringify({ msg: 'reconciler started', queue: RESULTS_QUEUE, concurrency: RECONCILER.resultsConcurrency }));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
