// REQ-PERF-005 (ADR-071) — the platform's own health for administrators, read from the deployment's Prometheus: every
// scrape target with its request rate, p95, 5xx share (OpenTelemetry server metrics), event-loop delay, memory and CPU;
// the stores the reconciler probes at scrape time and OpenBao's seal; the outbox and queue backlogs; each SLO indicator
// of the shared catalogue (packages/telemetry slo.ts) against its objective; the firing and pending SLO alerts; and the
// perf budget results under PERF_RESULTS_DIR judged against PERF_BUDGETS. Nothing here is computed from a guess: an
// indicator with no data says so, and an unreachable Prometheus is reported rather than hidden.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  PLATFORM_HEALTH,
  TIME,
  type PlatformQueueState,
  type PlatformWindowMinutes,
} from '@openmap/constants';
import { PERF_RESULT_NAMES, parsePerfResult, type PerfBudgetCheck, type ParsedPerfResult } from '@openmap/contracts';
import { PLATFORM_SLIS, PLATFORM_SLI_IDS, promWindow, withSpan, type PlatformSliId, type PlatformSliUnit } from '@openmap/telemetry';
import { Counter } from 'prom-client';
import { z } from 'zod';
import { parseInput } from '../common/validation.js';
import { ENV, type Env } from '../config/env.module.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { PrometheusClient, type PromAlert, type PromSample, type PromTarget } from './prometheus.client.js';

export type TargetHealth = 'up' | 'down' | 'unknown';
export type SliStatus = 'ok' | 'breach' | 'no_data';

export interface PlatformTargetView {
  service: string;
  job: string;
  instance: string;
  health: TargetHealth;
  lastScrapeAt: string | null;
  scrapeDurationMs: number | null;
  lastError: string | null;
  requestRate: number | null;
  p95Ms: number | null;
  errorRatio: number | null;
  eventLoopP99Ms: number | null;
  residentBytes: number | null;
  cpuCores: number | null;
}

export interface PlatformStoreView {
  store: string;
  up: boolean | null;
  probeMs: number | null;
}

export interface PlatformQueueView {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface PlatformSliView {
  id: PlatformSliId;
  unit: PlatformSliUnit;
  value: number | null;
  objective: number;
  status: SliStatus;
}

export interface PlatformAlertView {
  name: string;
  sli: PlatformSliId | null;
  severity: string;
  state: 'firing' | 'pending';
  subject: string | null;
  activeAt: string | null;
  value: number | null;
}

export interface PlatformHealthView {
  observedAt: string;
  windowMinutes: PlatformWindowMinutes;
  prometheus: { reachable: boolean; version: string | null; error: string | null };
  targets: PlatformTargetView[];
  stores: PlatformStoreView[];
  outbox: { pending: number | null; oldestAgeSeconds: number | null; deliveredPerSecond: number | null; failuresPerSecond: number | null };
  queues: PlatformQueueView[];
  slis: PlatformSliView[];
  alerts: PlatformAlertView[];
  budgets: { configured: boolean; checks: PerfBudgetCheck[]; invalid: string[] };
}

const windowSchema = z
  .number()
  .int()
  .refine((v): v is PlatformWindowMinutes => (PLATFORM_HEALTH.windowsMinutes as readonly number[]).includes(v), {
    message: 'window must be one of ' + PLATFORM_HEALTH.windowsMinutes.join(', ') + ' minutes',
  });

/** The compose service a target is: its instance's host (`api:4000` → `api`). */
export function serviceOf(instance: string): string {
  const colon = instance.lastIndexOf(':');
  return colon > 0 ? instance.slice(0, colon) : instance;
}

/** The status of one indicator: every OpenMap SLO is an upper bound. */
export function sliStatus(value: number | null, objective: number): SliStatus {
  if (value === null) return 'no_data';
  return value <= objective ? 'ok' : 'breach';
}

const first = (samples: readonly PromSample[]): number | null => samples[0]?.value ?? null;
const ms = (seconds: number | null): number | null => (seconds === null ? null : seconds * TIME.msPerSecond);

function byLabel(samples: readonly PromSample[], label: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const s of samples) {
    const key = s.labels[label];
    if (key !== undefined) out.set(key, s.value);
  }
  return out;
}

/** PromQL for the per-target figures; `w` is the rate window. */
export function targetQueries(w: string): Record<'rate' | 'p95' | 'errors' | 'lag' | 'rss' | 'cpu', string> {
  const count = 'openmap_http_server_request_duration_seconds_count';
  const job = '{job="' + PLATFORM_HEALTH.jobs.services + '"}';
  return {
    rate: 'sum by (exported_job) (rate(' + count + '[' + w + ']))',
    p95:
      'histogram_quantile(' + String(PLATFORM_HEALTH.quantile) +
      ', sum by (exported_job, le) (rate(openmap_http_server_request_duration_seconds_bucket[' + w + '])))',
    errors:
      '(sum by (exported_job) (rate(' + count + '{http_response_status_code=~"5.."}[' + w + '])) or (0 * sum by (exported_job) (rate(' +
      count + '[' + w + '])))) / sum by (exported_job) (rate(' + count + '[' + w + ']))',
    lag: 'max by (instance) (nodejs_eventloop_lag_p99_seconds' + job + ')',
    rss: 'max by (instance) (process_resident_memory_bytes' + job + ')',
    cpu: 'sum by (instance) (rate(process_cpu_seconds_total' + job + '[' + w + ']))',
  };
}

function alertView(a: PromAlert): PlatformAlertView | null {
  if (a.state === 'inactive') return null;
  const sliLabel = a.labels[PLATFORM_HEALTH.sliLabel];
  if (sliLabel === undefined) return null;
  const sli = (PLATFORM_SLI_IDS as readonly string[]).includes(sliLabel) ? (sliLabel as PlatformSliId) : null;
  const value = a.value === undefined ? null : Number(a.value);
  return {
    name: a.labels['alertname'] ?? sliLabel,
    sli,
    severity: a.labels['severity'] ?? '',
    state: a.state,
    subject: a.labels['instance'] ?? a.labels['store'] ?? a.labels['queue'] ?? a.labels['exported_job'] ?? null,
    activeAt: a.activeAt ?? null,
    value: value !== null && Number.isFinite(value) ? value : null,
  };
}

@Injectable()
export class PlatformHealthService {
  /** Replaceable so unit tests can answer for Prometheus (the field-cipher service does the same with fetch). */
  prometheus: PrometheusClient;
  private readonly reads: Counter<'outcome'>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    metrics: MetricsService,
  ) {
    this.prometheus = new PrometheusClient(env.PROMETHEUS_URL);
    this.reads = new Counter({
      name: PLATFORM_HEALTH.metrics.reads,
      help: 'Platform health reads, by outcome (ok, or prometheus_unreachable)',
      labelNames: ['outcome'],
      registers: [metrics.registry],
    });
  }

  async read(windowMinutes: unknown, now: Date = new Date()): Promise<PlatformHealthView> {
    const minutes = parseInput(windowSchema, windowMinutes ?? PLATFORM_HEALTH.windowsMinutes[0], 'windowMinutes');
    return withSpan(TRACER_NAME, 'platform.health', { 'openmap.window_minutes': minutes }, async (span) => {
      const budgets = await this.budgets();
      let version: string;
      try {
        version = await this.prometheus.version();
      } catch (err) {
        this.reads.inc({ outcome: 'prometheus_unreachable' });
        span.setAttribute('openmap.prometheus_reachable', false);
        return this.unreachable(minutes, now, err instanceof Error ? err.message : String(err), budgets);
      }
      const view = await this.fromPrometheus(minutes, now, version, budgets);
      this.reads.inc({ outcome: 'ok' });
      span.setAttribute('openmap.prometheus_reachable', true);
      span.setAttribute('openmap.alerts_firing', view.alerts.filter((a) => a.state === 'firing').length);
      return view;
    });
  }

  /** A query that fails (a series Prometheus cannot evaluate) counts as no data for that figure. */
  private async q(expr: string): Promise<PromSample[]> {
    return this.prometheus.query(expr).catch(() => []);
  }

  private async fromPrometheus(
    minutes: PlatformWindowMinutes,
    now: Date,
    version: string,
    budgets: PlatformHealthView['budgets'],
  ): Promise<PlatformHealthView> {
    const w = promWindow(minutes);
    const tq = targetQueries(w);
    const M = PLATFORM_HEALTH.metrics;
    const [targets, alerts, rate, p95, errors, lag, rss, cpu, storeUp, probe, pending, oldest, delivered, failures, queues, slis] =
      await Promise.all([
        this.prometheus.targets().catch(() => [] as PromTarget[]),
        this.prometheus.alerts().catch(() => [] as PromAlert[]),
        this.q(tq.rate),
        this.q(tq.p95),
        this.q(tq.errors),
        this.q(tq.lag),
        this.q(tq.rss),
        this.q(tq.cpu),
        this.q('max by (store) (' + M.storeUp + ')'),
        this.q('max by (store) (' + M.storeProbeSeconds + ')'),
        this.q('max(' + M.outboxPending + ')'),
        this.q('max(' + M.outboxOldest + ')'),
        this.q('sum(rate(openmap_outbox_delivered_total[' + w + ']))'),
        this.q('sum(rate(openmap_outbox_failures_total[' + w + ']))'),
        this.q('max by (queue, state) (' + M.queueJobs + ')'),
        Promise.all(PLATFORM_SLIS.map(async (s) => ({ s, value: first(await this.q(s.expr(w))) }))),
      ]);

    const otel = (m: Map<string, number | null>, service: string): number | null =>
      m.get(PLATFORM_HEALTH.otelServicePrefix + service) ?? null;
    const rateBy = byLabel(rate, 'exported_job');
    const p95By = byLabel(p95, 'exported_job');
    const errorsBy = byLabel(errors, 'exported_job');
    const lagBy = byLabel(lag, 'instance');
    const rssBy = byLabel(rss, 'instance');
    const cpuBy = byLabel(cpu, 'instance');
    const targetViews: PlatformTargetView[] = targets.map((t) => {
      const instance = t.labels['instance'] ?? '';
      const service = serviceOf(instance);
      return {
        service,
        job: t.labels['job'] ?? t.scrapePool,
        instance,
        health: t.health,
        lastScrapeAt: t.lastScrape.startsWith('0001-') ? null : t.lastScrape,
        scrapeDurationMs: t.lastScrapeDuration * TIME.msPerSecond,
        lastError: t.lastError === '' ? null : t.lastError,
        requestRate: otel(rateBy, service),
        p95Ms: ms(otel(p95By, service)),
        errorRatio: otel(errorsBy, service),
        eventLoopP99Ms: ms(lagBy.get(instance) ?? null),
        residentBytes: rssBy.get(instance) ?? null,
        cpuCores: cpuBy.get(instance) ?? null,
      };
    });
    // An expected service Prometheus does not scrape at all is shown, not silently left out.
    for (const service of PLATFORM_HEALTH.services) {
      if (!targetViews.some((t) => t.service === service)) targetViews.push(this.unscraped(service));
    }

    const upBy = byLabel(storeUp, 'store');
    const probeBy = byLabel(probe, 'store');
    const sealed = slis.find((x) => x.s.id === 'openbao_sealed')?.value ?? null;
    const stores: PlatformStoreView[] = PLATFORM_HEALTH.stores.map((store) => {
      if (store === 'openbao') return { store, up: sealed === null ? null : sealed === 0, probeMs: null };
      const up = upBy.get(store);
      return { store, up: up === undefined || up === null ? null : up === 1, probeMs: ms(probeBy.get(store) ?? null) };
    });

    const queueViews = new Map<string, PlatformQueueView>();
    for (const s of queues) {
      const name = s.labels['queue'];
      const state = s.labels['state'] as PlatformQueueState | undefined;
      if (name === undefined || state === undefined || !(PLATFORM_HEALTH.queueStates as readonly string[]).includes(state)) continue;
      const row = queueViews.get(name) ?? { queue: name, waiting: 0, active: 0, delayed: 0, failed: 0 };
      row[state] = s.value ?? 0;
      queueViews.set(name, row);
    }

    const pendingValue = first(pending);
    return {
      observedAt: now.toISOString(),
      windowMinutes: minutes,
      prometheus: { reachable: true, version, error: null },
      targets: targetViews.sort((a, b) => a.service.localeCompare(b.service)),
      stores,
      outbox: {
        pending: pendingValue === null ? null : Math.round(pendingValue),
        oldestAgeSeconds: first(oldest),
        deliveredPerSecond: first(delivered),
        failuresPerSecond: first(failures),
      },
      queues: [...queueViews.values()].sort((a, b) => a.queue.localeCompare(b.queue)),
      slis: slis.map(({ s, value }) => ({ id: s.id, unit: s.unit, value, objective: s.objective, status: sliStatus(value, s.objective) })),
      alerts: alerts
        .map(alertView)
        .filter((a): a is PlatformAlertView => a !== null)
        .sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'firing' ? -1 : 1))
        .slice(0, PLATFORM_HEALTH.alertsLimit),
      budgets,
    };
  }

  private unscraped(service: string): PlatformTargetView {
    return {
      service,
      job: PLATFORM_HEALTH.jobs.services,
      instance: service,
      health: 'unknown',
      lastScrapeAt: null,
      scrapeDurationMs: null,
      lastError: null,
      requestRate: null,
      p95Ms: null,
      errorRatio: null,
      eventLoopP99Ms: null,
      residentBytes: null,
      cpuCores: null,
    };
  }

  private unreachable(
    minutes: PlatformWindowMinutes,
    now: Date,
    error: string,
    budgets: PlatformHealthView['budgets'],
  ): PlatformHealthView {
    return {
      observedAt: now.toISOString(),
      windowMinutes: minutes,
      prometheus: { reachable: false, version: null, error },
      targets: PLATFORM_HEALTH.services.map((s) => this.unscraped(s)),
      stores: PLATFORM_HEALTH.stores.map((store) => ({ store, up: null, probeMs: null })),
      outbox: { pending: null, oldestAgeSeconds: null, deliveredPerSecond: null, failuresPerSecond: null },
      queues: [],
      slis: PLATFORM_SLIS.map((s) => ({ id: s.id, unit: s.unit, value: null, objective: s.objective, status: 'no_data' })),
      alerts: [],
      budgets,
    };
  }

  /** The perf results under PERF_RESULTS_DIR, judged against PERF_BUDGETS (the same checks `pnpm guard` runs in CI). */
  async budgets(): Promise<PlatformHealthView['budgets']> {
    const dir = this.env.PERF_RESULTS_DIR;
    if (dir === undefined) return { configured: false, checks: [], invalid: [] };
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return { configured: true, checks: [], invalid: [] };
    }
    const parsed: ParsedPerfResult[] = [];
    for (const file of files) {
      try {
        parsed.push(parsePerfResult(file, await readFile(join(dir, file), 'utf8')));
      } catch (err) {
        parsed.push({ ok: false, file, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const order = (name: string): number => {
      const i = (PERF_RESULT_NAMES as readonly string[]).indexOf(name);
      return i < 0 ? PERF_RESULT_NAMES.length : i;
    };
    const checks = parsed
      .flatMap((p) => (p.ok ? p.checks : []))
      .sort((a, b) => order(a.result) - order(b.result) || (a.page ?? '').localeCompare(b.page ?? ''));
    return { configured: true, checks, invalid: parsed.flatMap((p) => (p.ok ? [] : [p.file + ': ' + p.error])) };
  }
}
