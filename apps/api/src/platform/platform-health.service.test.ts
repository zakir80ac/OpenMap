// T-614 REQ-PERF-005 (ADR-071) — the platform health view from Prometheus answers (the HTTP API's own JSON shapes):
// targets joined with their OpenTelemetry and process figures by service and instance, an expected service that is not
// scraped shown as unknown, stores from the reconciler's probes and OpenBao from its seal, queues pivoted by state, SLO
// indicators judged against their objectives (no data when Prometheus has none), only SLO alerts kept, firing first;
// an unreachable Prometheus reported with its error; the window validated; perf results judged from PERF_RESULTS_DIR;
// and the GraphQL enum of indicators equal to the catalogue.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchema, isEnumType } from 'graphql';
import { loadEnv } from '@openmap/config';
import { PERF_BUDGETS, PLATFORM_HEALTH } from '@openmap/constants';
import { PLATFORM_SLI_IDS } from '@openmap/telemetry';
import { afterAll, describe, expect, it } from 'vitest';
import { MetricsService } from '../metrics/metrics.service.js';
import { PrometheusClient } from './prometheus.client.js';
import { PlatformHealthService, serviceOf, sliStatus, targetQueries } from './platform-health.service.js';

const dir = mkdtempSync(join(tmpdir(), 'openmap-perf-results-'));
writeFileSync(join(dir, 'impact-query.json'), JSON.stringify({ name: 'impact-query', p95Ms: 412.5, generatedAt: '2026-11-09T10:00:00.000Z' }));
writeFileSync(join(dir, 'graph-render.json'), JSON.stringify({ name: 'graph-render', fps: 58 }));
writeFileSync(join(dir, 'broken.json'), '{');
writeFileSync(join(dir, 'notes.txt'), 'not a result');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = loadEnv({ PROMETHEUS_URL: 'http://prometheus.test:9090', PERF_RESULTS_DIR: dir });
const now = Date.parse('2026-11-10T12:00:00.000Z') / 1000;

const vector = (rows: Array<[Record<string, string>, string]>): unknown => ({
  status: 'success',
  data: { resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [now, v] })) },
});

function answer(expr: string): unknown {
  const w = '[5m]';
  const tq = targetQueries('5m');
  if (expr === tq.rate) return vector([[{ exported_job: 'openmap-api' }, '12.5'], [{ exported_job: 'openmap-scheduler' }, '0.4']]);
  if (expr === tq.p95) return vector([[{ exported_job: 'openmap-api' }, '0.042'], [{ exported_job: 'openmap-scheduler' }, 'NaN']]);
  if (expr === tq.errors) return vector([[{ exported_job: 'openmap-api' }, '0.002']]);
  if (expr === tq.lag) return vector([[{ instance: 'api:4000' }, '0.011'], [{ instance: 'reconciler:4100' }, '0.3']]);
  if (expr === tq.rss) return vector([[{ instance: 'api:4000' }, '312000000']]);
  if (expr === tq.cpu) return vector([[{ instance: 'api:4000' }, '0.25']]);
  if (expr.startsWith('max by (store) (openmap_store_up)'))
    return vector([[{ store: 'postgres' }, '1'], [{ store: 'memgraph' }, '1'], [{ store: 'clickhouse' }, '1'], [{ store: 'valkey' }, '0']]);
  if (expr.startsWith('max by (store) (openmap_store_probe_seconds)')) return vector([[{ store: 'postgres' }, '0.003']]);
  if (expr === 'max(openmap_outbox_pending_events)') return vector([[{}, '7']]);
  if (expr === 'max(openmap_outbox_oldest_pending_age_seconds)') return vector([[{}, '12.5']]);
  if (expr.includes('openmap_outbox_delivered_total')) return vector([[{}, '40']]);
  if (expr.includes('openmap_outbox_failures_total')) return vector([]);
  if (expr === 'max by (queue, state) (openmap_queue_jobs)')
    return vector([
      [{ queue: 'openmap-collector-results', state: 'waiting' }, '3'],
      [{ queue: 'openmap-collector-results', state: 'failed' }, '1'],
      [{ queue: 'openmap-events', state: 'active' }, '2'],
      [{ queue: 'openmap-events', state: 'paused' }, '9'],
    ]);
  // SLO indicators.
  if (expr.startsWith('count(up{')) return vector([[{}, '1']]);
  if (expr.startsWith('count(max by (store)')) return vector([[{}, '1']]);
  if (expr.startsWith('(1 - min(vault_core_unsealed')) return vector([[{}, '0']]);
  if (expr.startsWith('histogram_quantile') && expr.includes('openmap_graphql_duration_seconds_bucket' + w)) return vector([[{}, '0.13']]);
  if (expr.includes('openmap_graphql_requests_total')) return vector([[{}, 'NaN']]);
  if (expr.startsWith('time() - max(openmap_backup')) return vector([[{}, '3600']]);
  if (expr.startsWith('max(nodejs_eventloop_lag_p99_seconds')) return { status: 'error', errorType: 'bad_data', error: 'parse error' };
  return vector([]);
}

function fakePrometheus(reachable = true): typeof fetch {
  return async (input) => {
    if (!reachable) throw new TypeError('fetch failed: connect ECONNREFUSED');
    const url = new URL(String(input));
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/v1/status/buildinfo') return json({ status: 'success', data: { version: '3.4.1' } });
    if (url.pathname === '/api/v1/targets')
      return json({
        status: 'success',
        data: {
          activeTargets: [
            { labels: { instance: 'api:4000', job: 'openmap-services' }, scrapePool: 'openmap-services', health: 'up', lastError: '', lastScrape: '2026-11-10T11:59:55.000Z', lastScrapeDuration: 0.018 },
            { labels: { instance: 'reconciler:4100', job: 'openmap-services' }, scrapePool: 'openmap-services', health: 'down', lastError: 'connection refused', lastScrape: '2026-11-10T11:59:50.000Z', lastScrapeDuration: 0.001 },
            { labels: { instance: 'clickhouse:9363', job: 'clickhouse' }, scrapePool: 'clickhouse', health: 'up', lastError: '', lastScrape: '0001-01-01T00:00:00Z', lastScrapeDuration: 0 },
          ],
        },
      });
    if (url.pathname === '/api/v1/alerts')
      return json({
        status: 'success',
        data: {
          alerts: [
            { labels: { alertname: 'OpenMapStoreDown', store: 'valkey', severity: 'critical', openmap_sli: 'stores_down' }, state: 'pending', activeAt: '2026-11-10T11:59:00Z', value: '0e+00' },
            { labels: { alertname: 'OpenMapTargetDown', instance: 'reconciler:4100', severity: 'critical', openmap_sli: 'targets_down' }, state: 'firing', activeAt: '2026-11-10T11:55:00Z', value: '0e+00' },
            { labels: { alertname: 'SomeoneElsesAlert', severity: 'warning' }, state: 'firing' },
          ],
        },
      });
    if (url.pathname === '/api/v1/query') return json(answer(url.searchParams.get('query') ?? ''));
    return new Response('not found', { status: 404 });
  };
}

function service(reachable = true): PlatformHealthService {
  const s = new PlatformHealthService(env, new MetricsService());
  s.prometheus = new PrometheusClient(env.PROMETHEUS_URL, fakePrometheus(reachable));
  return s;
}

describe('platform health', () => {
  it('joins targets with their figures and shows an expected service that is not scraped', async () => {
    const view = await service().read(undefined, new Date(now * 1000));
    expect(view.prometheus).toEqual({ reachable: true, version: '3.4.1', error: null });
    expect(view.windowMinutes).toBe(PLATFORM_HEALTH.windowsMinutes[0]);
    const api = view.targets.find((t) => t.service === 'api');
    expect(api).toMatchObject({ health: 'up', requestRate: 12.5, errorRatio: 0.002, residentBytes: 312000000, cpuCores: 0.25, lastError: null });
    expect(api?.p95Ms).toBeCloseTo(42);
    expect(api?.eventLoopP99Ms).toBeCloseTo(11);
    expect(view.targets.find((t) => t.service === 'reconciler')).toMatchObject({ health: 'down', lastError: 'connection refused' });
    expect(view.targets.find((t) => t.service === 'clickhouse')?.lastScrapeAt).toBeNull();
    for (const s of ['scheduler', 'bsm-engine']) expect(view.targets.find((t) => t.service === s)?.health).toBe('unknown');
    expect(view.targets.map((t) => t.service)).toEqual([...view.targets.map((t) => t.service)].sort());
  });

  it('reads stores, the outbox and the queues', async () => {
    const view = await service().read(undefined);
    expect(view.stores.map((s) => [s.store, s.up])).toEqual([
      ['postgres', true],
      ['memgraph', true],
      ['clickhouse', true],
      ['valkey', false],
      ['meilisearch', null],
      ['openbao', true],
    ]);
    expect(view.stores[0]?.probeMs).toBeCloseTo(3);
    expect(view.outbox).toEqual({ pending: 7, oldestAgeSeconds: 12.5, deliveredPerSecond: 40, failuresPerSecond: null });
    expect(view.queues).toEqual([
      { queue: 'openmap-collector-results', waiting: 3, active: 0, delayed: 0, failed: 1 },
      { queue: 'openmap-events', waiting: 0, active: 2, delayed: 0, failed: 0 },
    ]);
  });

  it('judges each indicator against its objective and keeps only SLO alerts, firing first', async () => {
    const view = await service().read(undefined);
    const byId = new Map(view.slis.map((s) => [s.id, s]));
    expect(view.slis.map((s) => s.id)).toEqual([...PLATFORM_SLI_IDS]);
    expect(byId.get('targets_down')).toMatchObject({ value: 1, objective: 0, status: 'breach' });
    expect(byId.get('openbao_sealed')?.status).toBe('ok');
    expect(byId.get('graphql_p95_seconds')).toMatchObject({ value: 0.13, objective: PERF_BUDGETS.screenInteractionP95Ms / 1000, status: 'breach' });
    expect(byId.get('graphql_error_ratio')).toMatchObject({ value: null, status: 'no_data' });
    expect(byId.get('event_loop_lag_p99_seconds')?.status).toBe('no_data');
    expect(byId.get('backup_age_seconds')?.status).toBe('ok');
    expect(view.alerts).toEqual([
      { name: 'OpenMapTargetDown', sli: 'targets_down', severity: 'critical', state: 'firing', subject: 'reconciler:4100', activeAt: '2026-11-10T11:55:00Z', value: 0 },
      { name: 'OpenMapStoreDown', sli: 'stores_down', severity: 'critical', state: 'pending', subject: 'valkey', activeAt: '2026-11-10T11:59:00Z', value: 0 },
    ]);
  });

  it('reports an unreachable Prometheus with its error, and every indicator without data', async () => {
    const view = await service(false).read(undefined);
    expect(view.prometheus.reachable).toBe(false);
    expect(view.prometheus.error).toMatch(/ECONNREFUSED/u);
    expect(view.slis.every((s) => s.status === 'no_data')).toBe(true);
    expect(view.stores.every((s) => s.up === null)).toBe(true);
    expect(view.targets.map((t) => t.health)).toEqual(PLATFORM_HEALTH.services.map(() => 'unknown'));
    // Budgets do not need Prometheus.
    expect(view.budgets.checks.length).toBe(2);
  });

  it('accepts only the configured windows', async () => {
    expect((await service().read(60)).windowMinutes).toBe(60);
    await expect(service().read(7)).rejects.toThrow(/windowMinutes/u);
  });

  it('judges the perf results in PERF_RESULTS_DIR and names the unreadable ones', async () => {
    const budgets = await service().budgets();
    expect(budgets.configured).toBe(true);
    expect(budgets.checks.map((c) => [c.result, c.withinBudget])).toEqual([
      ['graph-render', false],
      ['impact-query', true],
    ]);
    expect(budgets.invalid).toHaveLength(1);
    expect(budgets.invalid[0]).toMatch(/^broken\.json: /u);
    const none = new PlatformHealthService(loadEnv({}), new MetricsService());
    expect(await none.budgets()).toEqual({ configured: false, checks: [], invalid: [] });
  });

  it('names services by their target host and treats every SLO as an upper bound', () => {
    expect(serviceOf('bsm-engine:4400')).toBe('bsm-engine');
    expect(serviceOf('api')).toBe('api');
    expect(sliStatus(0, 0)).toBe('ok');
    expect(sliStatus(0.2, 0.1)).toBe('breach');
    expect(sliStatus(null, 1)).toBe('no_data');
  });

  it('serves the same indicator ids in the GraphQL contract', () => {
    const sdl = readFileSync(fileURLToPath(new URL('../../../../packages/contracts/graphql/schema.graphql', import.meta.url)), 'utf8');
    const type = buildSchema(sdl).getType('PlatformSliId');
    expect(isEnumType(type) ? type.getValues().map((v) => v.name) : []).toEqual([...PLATFORM_SLI_IDS]);
  });
});
