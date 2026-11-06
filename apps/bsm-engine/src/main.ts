// REQ-BSM-001 REQ-BSM-002 REQ-BSM-006 REQ-CORE-014 — BSM engine service: consumes the event stream the reconciler
// publishes, applies CI health, recomputes services per tenant after a short debounce, and re-evaluates every known
// tenant on a timer so stale CIs, expiring certificates, SLA budgets and missed response targets surface without new
// events. Every recompute and SLA evaluation is traced and counted; /metrics, /healthz and /readyz on BSM_ENGINE_PORT.
import './instrumentation.js';
import { createClient } from '@clickhouse/client';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { BSM, CERTIFICATES, RECONCILER } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { eventEnvelopeSchema } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { Counter, Histogram, createMetricsServer, createRegistry, withSpan } from '@openmap/telemetry';
import { createHistoryReader } from './core/history.js';
import { createOpenBaoReader } from './service/openbao.js';
import { checkCertificates } from './service/certificates.js';
import { createEngine } from './service/engine.js';

const TRACER = 'openmap-bsm-engine';

/** Prometheus metrics of the BSM engine: events applied, recomputes by outcome and their duration. */
export function createBsmMetrics() {
  const registry = createRegistry();
  return {
    registry,
    events: new Counter({
      name: 'openmap_bsm_events_total',
      help: 'Event-stream envelopes applied to CI health',
      registers: [registry],
    }),
    recomputes: new Counter({
      name: 'openmap_bsm_recomputes_total',
      help: 'Tenant service recomputes, by outcome',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    recomputeDuration: new Histogram({
      name: 'openmap_bsm_recompute_duration_seconds',
      help: 'Time to recompute one tenant',
      registers: [registry],
    }),
    serviceChanges: new Counter({
      name: 'openmap_bsm_service_changes_total',
      help: 'Business services whose propagated state changed',
      registers: [registry],
    }),
    slaEvaluations: new Counter({
      name: 'openmap_bsm_sla_evaluations_total',
      help: 'SLA-assigned services evaluated, by outcome',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    certificateAlerts: new Counter({
      name: 'openmap_bsm_certificate_alerts_total',
      help: 'Certificate expiry alerts raised (REQ-CMDB-032), and failed checks',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    slaDuration: new Histogram({
      name: 'openmap_bsm_sla_evaluation_duration_seconds',
      help: "Time to evaluate one tenant's SLAs and incident targets",
      registers: [registry],
    }),
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const graph = createGraphRepository(env);
  await graph.ensureSchema();
  const log = (line: Record<string, unknown>): void => console.log(JSON.stringify(line));
  const metrics = createBsmMetrics();
  const clickhouse = createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    database: env.CLICKHOUSE_DB,
  });
  const history = createHistoryReader(async (name, sql, params) => {
    const result = await withSpan(
      TRACER,
      'clickhouse.' + name,
      { 'db.system': 'clickhouse', 'db.operation': name },
      () => clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' }),
    );
    return result.json();
  }, env.CLICKHOUSE_DB);
  const engine = createEngine({
    prisma,
    graph,
    secrets: createOpenBaoReader(env),
    history,
    now: () => new Date().toISOString(),
    log,
    delivery: {
      fetchImpl: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date().toISOString(),
    },
  });
  const pending = new Map<string, NodeJS.Timeout>();
  const known = new Set<string>((await prisma.tenant.findMany({ select: { id: true } })).map((t) => t.id));
  const recompute = async (tenantId: string): Promise<void> => {
    const stop = metrics.recomputeDuration.startTimer();
    try {
      const report = await withSpan(TRACER, 'bsm.recompute', { 'openmap.tenant_id': tenantId }, () =>
        engine.recomputeTenant(tenantId),
      );
      metrics.recomputes.inc({ outcome: 'ok' });
      metrics.serviceChanges.inc(report.changed);
      if (report.changed > 0) log({ msg: 'services recomputed', ...report });
    } catch (err) {
      metrics.recomputes.inc({ outcome: 'error' });
      log({ msg: 'recompute failed', tenantId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      stop();
    }
    const stopSla = metrics.slaDuration.startTimer();
    try {
      const sla = await withSpan(TRACER, 'bsm.evaluate_slas', { 'openmap.tenant_id': tenantId }, () =>
        engine.evaluateSlas(tenantId),
      );
      metrics.slaEvaluations.inc({ outcome: 'ok' }, sla.evaluated);
      if (sla.breaches + sla.atRisk + sla.cleared + sla.responseMissed + sla.resolutionMissed > 0)
        log({ msg: 'sla evaluated', ...sla });
    } catch (err) {
      metrics.slaEvaluations.inc({ outcome: 'error' });
      log({
        msg: 'sla evaluation failed',
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      stopSla();
    }
  };
  const schedule = (tenantId: string): void => {
    known.add(tenantId);
    const existing = pending.get(tenantId);
    if (existing) clearTimeout(existing);
    pending.set(
      tenantId,
      setTimeout(() => {
        pending.delete(tenantId);
        void recompute(tenantId);
      }, BSM.recomputeDebounceMs),
    );
  };
  const connection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const worker = new Worker(
    RECONCILER.eventStreamQueue,
    async (job) => {
      const e = eventEnvelopeSchema.parse(job.data);
      const report = await withSpan(
        TRACER,
        'bsm.apply_event',
        { 'openmap.event_type': e.type, 'openmap.tenant_id': e.tenantid },
        () => engine.applyCiEvents([e]),
      );
      metrics.events.inc();
      for (const tenantId of report.tenants) schedule(tenantId);
      return report;
    },
    { connection, concurrency: RECONCILER.resultsConcurrency },
  );
  const tick = setInterval(() => {
    for (const tenantId of known) void recompute(tenantId);
  }, BSM.tickMs);
  // REQ-CMDB-032 (ADR-036): certificates crossing an expiry threshold raise one alert each.
  const certificateCheck = async (): Promise<void> => {
    try {
      const report = await withSpan(TRACER, 'bsm.check_certificates', {}, () => checkCertificates(prisma, new Date()));
      metrics.certificateAlerts.inc({ outcome: 'raised' }, report.raised);
      if (report.raised > 0) log({ msg: 'certificate alerts raised', ...report });
    } catch (err) {
      metrics.certificateAlerts.inc({ outcome: 'error' });
      log({ msg: 'certificate check failed', error: err instanceof Error ? err.message : String(err) });
    }
  };
  const certificateTick = setInterval(() => {
    void certificateCheck();
  }, CERTIFICATES.checkEveryMs);
  void certificateCheck();
  const metricsServer = await createMetricsServer({
    registry: metrics.registry,
    port: env.BSM_ENGINE_PORT,
    path: env.METRICS_PATH,
    ready: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
    log,
  });
  const shutdown = async (): Promise<void> => {
    await metricsServer.close();
    clearInterval(tick);
    clearInterval(certificateTick);
    for (const t of pending.values()) clearTimeout(t);
    await worker.close();
    await clickhouse.close();
    await graph.close();
    await prisma.$disconnect();
    await connection.quit();
  };
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  for (const tenantId of known) void recompute(tenantId);
  log({
    msg: 'bsm engine started',
    queue: RECONCILER.eventStreamQueue,
    tenants: known.size,
    tickMs: BSM.tickMs,
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
