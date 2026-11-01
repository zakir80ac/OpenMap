// REQ-CORE-013 REQ-CORE-005 REQ-CORE-014 — reconciler service: BullMQ worker over collector results plus the
// outbox dispatcher loop, each unit of work traced and counted; /metrics, /healthz and /readyz on RECONCILER_PORT.
// Both loops stop cleanly on SIGINT/SIGTERM.
import './instrumentation.js';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { RECONCILER } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { collectorResultSchema } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { Counter, Histogram, createMetricsServer, createRegistry, withSpan } from '@openmap/telemetry';
import { createClickHouse, createEventStream, createMeilisearchSink, dispatchOnce } from './worker/dispatcher.js';
import { processResult, retryPendingRelationships } from './worker/pipeline.js';

const RESULTS_QUEUE = RECONCILER.resultsQueue;
const TRACER = 'openmap-reconciler';

/** Prometheus metrics of the reconciler: results by collector and outcome, their duration, outbox batches and failures by target. */
export function createReconcilerMetrics() {
  const registry = createRegistry();
  return {
    registry,
    results: new Counter({ name: 'openmap_reconciler_results_total', help: 'Collector results reconciled, by collector and outcome', labelNames: ['collector', 'outcome'], registers: [registry] }),
    resultDuration: new Histogram({ name: 'openmap_reconciler_result_duration_seconds', help: 'Time to reconcile one collector result', labelNames: ['collector'], registers: [registry] }),
    outboxBatches: new Counter({ name: 'openmap_outbox_batches_total', help: 'Outbox dispatcher ticks that claimed rows', registers: [registry] }),
    outboxDelivered: new Counter({ name: 'openmap_outbox_delivered_total', help: 'Outbox rows fully delivered', registers: [registry] }),
    outboxFailures: new Counter({ name: 'openmap_outbox_failures_total', help: 'Outbox target failures, by target', labelNames: ['target'], registers: [registry] }),
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const graph = createGraphRepository(env);
  await graph.ensureSchema();
  const sinks = { graph, clickhouse: createClickHouse(env), search: createMeilisearchSink(env), stream: createEventStream(env) };
  const metrics = createReconcilerMetrics();
  const connection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const worker = new Worker(
    RESULTS_QUEUE,
    async (job) => {
      const result = collectorResultSchema.parse(job.data);
      const stop = metrics.resultDuration.startTimer({ collector: result.collectorId });
      try {
        const summary = await withSpan(TRACER, 'reconcile.result', { 'openmap.collector': result.collectorId, 'openmap.run_id': result.runId, 'openmap.tenant_id': result.tenantId }, () => processResult(prisma, result));
        const retried = await withSpan(TRACER, 'reconcile.pending_relationships', { 'openmap.tenant_id': result.tenantId }, () => retryPendingRelationships(prisma, result.tenantId));
        metrics.results.inc({ collector: result.collectorId, outcome: 'ok' });
        console.log(JSON.stringify({ msg: 'reconciled', runId: result.runId, collector: result.collectorId, ...summary, pendingResolved: retried.resolved }));
        return summary;
      } catch (err) {
        metrics.results.inc({ collector: result.collectorId, outcome: 'error' });
        throw err;
      } finally {
        stop();
      }
    },
    { connection, concurrency: RECONCILER.resultsConcurrency },
  );
  let running = true;
  const loop = (async () => {
    while (running) {
      const report = await withSpan(TRACER, 'outbox.dispatch', {}, () => dispatchOnce(prisma, sinks, env.CLICKHOUSE_DB));
      if (report.claimed > 0) metrics.outboxBatches.inc();
      metrics.outboxDelivered.inc(report.delivered);
      for (const failure of report.failures) metrics.outboxFailures.inc({ target: failure.target });
      if (report.failures.length) console.error(JSON.stringify({ msg: 'outbox failures', ...report }));
      if (report.claimed === 0) await new Promise((r) => setTimeout(r, RECONCILER.outboxIdleMs));
    }
  })();
  const metricsServer = await createMetricsServer({
    registry: metrics.registry,
    port: env.RECONCILER_PORT,
    path: env.METRICS_PATH,
    ready: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return running;
    },
    log: (line) => console.log(JSON.stringify(line)),
  });
  const shutdown = async (): Promise<void> => {
    running = false;
    await metricsServer.close();
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
