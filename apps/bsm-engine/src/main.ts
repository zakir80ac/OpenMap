// REQ-BSM-001 REQ-BSM-002 REQ-BSM-006 REQ-CORE-014 — BSM engine service: consumes the event stream the reconciler
// publishes, applies CI health, recomputes services per tenant after a short debounce, and re-evaluates every known
// tenant on a timer so stale CIs, expiring certificates, SLA budgets and missed response targets surface without new
// events. Every recompute and SLA evaluation is traced and counted; /metrics, /healthz and /readyz on BSM_ENGINE_PORT.
// REQ-INT-012 (ADR-073): firing monitoring alerts overlay CI health, re-read when an ingest wakes the engine.
import './instrumentation.js';
import { createClient } from '@clickhouse/client';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { BSM, CERTIFICATES, ENVIRONMENT, MONITORING, POWER, READINESS, RECONCILER } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { eventEnvelopeSchema, type EventEnvelope } from '@openmap/contracts';
import { clickhouseOptions, createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { Counter, Histogram, createMetricsServer, createRegistry, withSpan } from '@openmap/telemetry';
import { createHistoryReader } from './core/history.js';
import { createNotifier } from './integrations/notify.js';
import { createOpenBaoReader } from './service/openbao.js';
import { checkCertificates } from './service/certificates.js';
import { createEngine } from './service/engine.js';
import { createReadiness } from './service/readiness.js';
import { createPowerAlerts } from './service/power.js';
import { createEnvironmentAlerts } from './service/environment.js';
import { createMonitoringHealth, wakesMonitoring } from './service/monitoring.js';

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
    readiness: new Counter({
      name: 'openmap_bsm_readiness_evaluations_total',
      help: 'HA / DR readiness evaluations of a tenant, by outcome',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    readinessBreaches: new Counter({
      name: 'openmap_bsm_readiness_findings_total',
      help: 'Readiness findings opened and cleared',
      labelNames: ['change'],
      registers: [registry],
    }),
    powerAlerts: new Counter({
      name: 'openmap_bsm_power_alerts_total',
      help: 'Power threshold incidents opened and resolved (REQ-DCIM-005)',
      labelNames: ['change'],
      registers: [registry],
    }),
    environmentAlerts: new Counter({
      name: 'openmap_bsm_environment_alerts_total',
      help: 'Rack inlet temperature incidents opened and resolved (REQ-DCIM-006)',
      labelNames: ['change'],
      registers: [registry],
    }),
    certificateAlerts: new Counter({
      name: 'openmap_bsm_certificate_alerts_total',
      help: 'Certificate expiry alerts raised (REQ-CMDB-032), and failed checks',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    notifications: new Counter({
      name: 'openmap_bsm_notifications_total',
      help: 'Notifications to webhooks, Slack, Teams, email and PagerDuty by vendor and outcome (REQ-INT-009)',
      labelNames: ['vendor', 'outcome'],
      registers: [registry],
    }),
    monitoringSyncs: new Counter({
      name: 'openmap_bsm_monitoring_syncs_total',
      help: 'Passes over changed monitoring alerts (REQ-INT-012), by outcome',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    monitoringHealthChanges: new Counter({
      name: 'openmap_bsm_monitoring_health_changes_total',
      help: 'CI health changes made by firing or cleared monitoring alerts (REQ-INT-012)',
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
  const clickhouse = createClient(clickhouseOptions(env));
  const history = createHistoryReader(async (name, sql, params) => {
    const result = await withSpan(
      TRACER,
      'clickhouse.' + name,
      { 'db.system': 'clickhouse', 'db.operation': name },
      () => clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' }),
    );
    return result.json();
  }, env.CLICKHOUSE_DB);
  // REQ-INT-012 (ADR-073): the overlay reads CI health through the engine (called only once both exist).
  const monitoring = createMonitoringHealth({
    prisma,
    graph,
    healthMap: (tenantId, ids) => engine.healthMap(tenantId, ids),
    now: () => new Date(),
  });
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
    alerts: monitoring.overlay,
  });
  // REQ-INT-009 (ADR-065): notifications to webhooks, Slack, Teams, email and PagerDuty for subscribed events.
  const notifier = createNotifier({
    prisma,
    secrets: createOpenBaoReader(env),
    delivery: {
      fetchImpl: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date().toISOString(),
    },
    consoleUrl: env.PUBLIC_CONSOLE_URL,
    outboundAllowed: env.DEPLOY_PROFILE !== 'airgap' && env.FEATURE_OUTBOUND_INTEGRATIONS,
    log,
    now: () => new Date(),
  });
  const notify = async (e: EventEnvelope): Promise<void> => {
    try {
      const report = await withSpan(
        TRACER,
        'bsm.notify',
        { 'openmap.event_type': e.type, 'openmap.tenant_id': e.tenantid },
        () => notifier.handle(e),
      );
      for (const o of report.outcomes) metrics.notifications.inc({ vendor: o.vendor, outcome: o.outcome });
    } catch (err) {
      metrics.notifications.inc({ vendor: 'unknown', outcome: 'error' });
      log({
        msg: 'notification failed',
        eventType: e.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
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
  const monitoringSync = async (): Promise<void> => {
    try {
      const report = await withSpan(TRACER, 'bsm.monitoring_sync', {}, () => monitoring.sync());
      metrics.monitoringSyncs.inc({ outcome: 'ok' });
      metrics.monitoringHealthChanges.inc(report.healthChanged);
      for (const tenantId of report.tenants) schedule(tenantId);
      if (report.healthChanged + report.expired > 0) log({ msg: 'monitoring alerts applied', ...report });
    } catch (err) {
      metrics.monitoringSyncs.inc({ outcome: 'error' });
      log({ msg: 'monitoring sync failed', error: err instanceof Error ? err.message : String(err) });
    }
  };
  // The overlay is loaded before the first event is applied, so a restart never re-derives an alerted CI healthy.
  await monitoringSync();
  const monitoringTick = setInterval(() => {
    void monitoringSync();
  }, MONITORING.engineSyncMs);
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
      if (wakesMonitoring(e)) void monitoringSync();
      // Notifications go out in the background: health propagation never waits on a slow channel or its retries.
      void notify(e);
      return report;
    },
    { connection, concurrency: RECONCILER.resultsConcurrency },
  );
  const tick = setInterval(() => {
    for (const tenantId of known) void recompute(tenantId);
  }, BSM.tickMs);
  // REQ-BSM-007 (ADR-025): link health from the probes and the HA / DR readiness rules, continuously.
  const readiness = createReadiness({
    prisma,
    graph,
    query: async (name, sql, params) => {
      const result = await withSpan(
        TRACER,
        'clickhouse.' + name,
        { 'db.system': 'clickhouse', 'db.operation': name },
        () => clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' }),
      );
      return result.json();
    },
    database: env.CLICKHOUSE_DB,
    healthMap: (tenantId, ids) => engine.healthMap(tenantId, ids),
    probeIntervalMs: env.LINK_PROBE_INTERVAL_MS === 0 ? READINESS.evaluateMs : env.LINK_PROBE_INTERVAL_MS,
    now: () => new Date().toISOString(),
  });
  const readinessCheck = async (): Promise<void> => {
    for (const tenantId of known) {
      try {
        const report = await withSpan(TRACER, 'bsm.readiness', { 'openmap.tenant_id': tenantId }, () =>
          readiness.evaluateTenant(tenantId),
        );
        metrics.readiness.inc({ outcome: 'ok' });
        metrics.readinessBreaches.inc({ change: 'opened' }, report.opened);
        metrics.readinessBreaches.inc({ change: 'cleared' }, report.cleared);
        if (report.linkHealthChanged > 0) schedule(tenantId);
        if (report.opened + report.cleared + report.linkHealthChanged > 0)
          log({ msg: 'readiness evaluated', tenantId, ...report });
      } catch (err) {
        metrics.readiness.inc({ outcome: 'error' });
        log({
          msg: 'readiness evaluation failed',
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  const readinessTick = setInterval(() => {
    void readinessCheck();
  }, READINESS.evaluateMs);
  // REQ-DCIM-005 (ADR-059): every PDU's latest draw against the tenant's critical line, continuously.
  const powerAlerts = createPowerAlerts({
    prisma,
    query: async (name, sql, params) => {
      const result = await withSpan(
        TRACER,
        'clickhouse.' + name,
        { 'db.system': 'clickhouse', 'db.operation': name },
        () => clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' }),
      );
      return result.json();
    },
    database: env.CLICKHOUSE_DB,
    now: () => new Date().toISOString(),
  });
  const powerCheck = async (): Promise<void> => {
    for (const tenantId of known) {
      try {
        const report = await withSpan(TRACER, 'bsm.power_alerts', { 'openmap.tenant_id': tenantId }, () =>
          powerAlerts.evaluateTenant(tenantId),
        );
        metrics.powerAlerts.inc({ change: 'opened' }, report.opened);
        metrics.powerAlerts.inc({ change: 'resolved' }, report.resolved);
        if (report.opened + report.resolved > 0) log({ msg: 'power alerts evaluated', tenantId, ...report });
      } catch (err) {
        log({
          msg: 'power alert evaluation failed',
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  const powerTick = setInterval(() => {
    void powerCheck();
  }, POWER.alertEvaluateMs);
  // REQ-DCIM-006 (ADR-060): every rack's fresh inlet temperature against the ASHRAE A1 allowable range.
  const environmentAlerts = createEnvironmentAlerts({
    prisma,
    query: async (name, sql, params) => {
      const result = await withSpan(
        TRACER,
        'clickhouse.' + name,
        { 'db.system': 'clickhouse', 'db.operation': name },
        () => clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' }),
      );
      return result.json();
    },
    database: env.CLICKHOUSE_DB,
    now: () => new Date().toISOString(),
  });
  const environmentCheck = async (): Promise<void> => {
    for (const tenantId of known) {
      try {
        const report = await withSpan(
          TRACER,
          'bsm.environment_alerts',
          { 'openmap.tenant_id': tenantId },
          () => environmentAlerts.evaluateTenant(tenantId),
        );
        metrics.environmentAlerts.inc({ change: 'opened' }, report.opened);
        metrics.environmentAlerts.inc({ change: 'resolved' }, report.resolved);
        if (report.opened + report.resolved > 0)
          log({ msg: 'environment alerts evaluated', tenantId, ...report });
      } catch (err) {
        log({
          msg: 'environment alert evaluation failed',
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  const environmentTick = setInterval(() => {
    void environmentCheck();
  }, ENVIRONMENT.evaluateMs);
  // REQ-CMDB-032 (ADR-036): certificates crossing an expiry threshold raise one alert each.
  const certificateCheck = async (): Promise<void> => {
    try {
      const report = await withSpan(TRACER, 'bsm.check_certificates', {}, () =>
        checkCertificates(prisma, new Date()),
      );
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
    clearInterval(readinessTick);
    clearInterval(powerTick);
    clearInterval(environmentTick);
    clearInterval(monitoringTick);
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
