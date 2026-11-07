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
import { AdmScheduler, runAdmPass, triggersAdm } from './worker/adm.js';
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
    /** REQ-CMDB-038 — metric samples per result: bound to a CI and queued for ClickHouse, or dropped for want of one. */
    samples: new Counter({ name: 'openmap_reconciler_metric_samples_total', help: 'Metric samples reconciled, by outcome (stored or dropped)', labelNames: ['outcome'], registers: [registry] }),
    // REQ-DEP-002 (ADR-029): dependency-mapping passes and the edges they created, refreshed or retired.
    admPasses: new Counter({ name: 'openmap_reconciler_adm_passes_total', help: 'Dependency-mapping passes, by outcome', labelNames: ['outcome'], registers: [registry] }),
    admEdges: new Counter({ name: 'openmap_reconciler_adm_edges_total', help: 'Derived dependency edges, by action (created, refreshed, retired)', labelNames: ['action'], registers: [registry] }),
    components: new Counter({ name: 'openmap_reconciler_components_total', help: 'Device parts synced from observed part lists, by action (upserted, removed)', labelNames: ['action'], registers: [registry] }),
    // REQ-CORE-013 (ADR-045): `*Ref` resolution: pending refs resolved, ref tokens computed, copies folded by ref key.
    identityRefs: new Counter({ name: 'openmap_reconciler_identity_refs_total', help: 'Identity ref work, by action (resolved, tokens, folded)', labelNames: ['action'], registers: [registry] }),
    admDuration: new Histogram({ name: 'openmap_reconciler_adm_duration_seconds', help: 'Dependency-mapping pass duration', registers: [registry] }),
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
  const adm = new AdmScheduler(async (tenantId) => {
    const stop = metrics.admDuration.startTimer();
    try {
      const summary = await withSpan(TRACER, 'reconcile.adm', { 'openmap.tenant_id': tenantId }, () => runAdmPass(prisma, tenantId));
      metrics.admPasses.inc({ outcome: 'ok' });
      metrics.admEdges.inc({ action: 'created' }, summary.created);
      metrics.admEdges.inc({ action: 'refreshed' }, summary.refreshed);
      metrics.admEdges.inc({ action: 'retired' }, summary.retired);
      console.log(JSON.stringify({ msg: 'dependencies derived', ...summary }));
    } catch (err) {
      metrics.admPasses.inc({ outcome: 'error' });
      console.error(JSON.stringify({ msg: 'dependency mapping failed', tenantId, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      stop();
    }
  });
  const worker = new Worker(
    RESULTS_QUEUE,
    async (job) => {
      const result = collectorResultSchema.parse(job.data);
      const stop = metrics.resultDuration.startTimer({ collector: result.collectorId });
      try {
        const summary = await withSpan(TRACER, 'reconcile.result', { 'openmap.collector': result.collectorId, 'openmap.run_id': result.runId, 'openmap.tenant_id': result.tenantId }, () => processResult(prisma, result));
        const retried = await withSpan(TRACER, 'reconcile.pending_relationships', { 'openmap.tenant_id': result.tenantId }, () => retryPendingRelationships(prisma, result.tenantId));
        metrics.results.inc({ collector: result.collectorId, outcome: 'ok' });
        metrics.samples.inc({ outcome: 'stored' }, summary.samples);
        metrics.samples.inc({ outcome: 'dropped' }, summary.samplesDropped);
        metrics.components.inc({ action: 'upserted' }, summary.componentsUpserted);
        metrics.components.inc({ action: 'removed' }, summary.componentsRemoved);
        metrics.identityRefs.inc({ action: 'resolved' }, retried.refs.resolved);
        metrics.identityRefs.inc({ action: 'tokens' }, retried.refs.tokens);
        metrics.identityRefs.inc({ action: 'folded' }, summary.folded + retried.refs.folded);
        if (triggersAdm(result)) adm.schedule(result.tenantId);
        console.log(JSON.stringify({ msg: 'reconciled', runId: result.runId, collector: result.collectorId, ...summary, pendingResolved: retried.resolved, refs: retried.refs }));
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
    await adm.drain();
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
