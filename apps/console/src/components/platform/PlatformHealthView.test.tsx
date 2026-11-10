// T-617 REQ-PERF-005 (ADR-071) — Platform health over stubbed GraphQL, in en and ar: the KPIs, every SLO indicator with
// its value, objective and status, firing alerts first with their subject, each scrape target with its figures and its
// scrape error, stores (one down, one with no data), the outbox and queues, and the perf budgets within and over; the
// window switch asks for another window; an unreachable Prometheus is said; non-administrators see no data.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import type { PlatformHealth } from '@/lib/platform-queries';
import { Providers } from '@/providers';
import { PlatformHealthView } from './PlatformHealthView';

const roles = { current: ['openmap-admin'] as string[] };
const authValue = (): AuthValue =>
  ({
    status: 'signed-in',
    user: { subject: 's1', username: 'admin', displayName: 'Admin', email: 'admin@bank.local', tenant: 'default', roles: roles.current },
    can: (role: string) => roles.current.includes('openmap-admin') || roles.current.includes(role),
    getAccessToken: () => 'tok',
  }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useAuth: () => authValue(), useCan: () => authValue().can }));

const health: PlatformHealth = {
  observedAt: '2026-11-10T12:00:00.000Z',
  windowMinutes: 5,
  prometheus: { reachable: true, version: '3.4.1', error: null },
  targets: [
    { service: 'api', job: 'openmap-services', instance: 'api:4000', health: 'up', lastScrapeAt: '2026-11-10T11:59:55.000Z', scrapeDurationMs: 18, lastError: null, requestRate: 12.5, p95Ms: 42, errorRatio: 0.002, eventLoopP99Ms: 11, residentBytes: 314572800, cpuCores: 0.25 },
    { service: 'reconciler', job: 'openmap-services', instance: 'reconciler:4100', health: 'down', lastScrapeAt: '2026-11-10T11:59:50.000Z', scrapeDurationMs: 1, lastError: 'connection refused', requestRate: null, p95Ms: null, errorRatio: null, eventLoopP99Ms: null, residentBytes: null, cpuCores: null },
  ],
  stores: [
    { store: 'postgres', up: true, probeMs: 3 },
    { store: 'valkey', up: false, probeMs: 2000 },
    { store: 'openbao', up: null, probeMs: null },
  ],
  outbox: { pending: 7, oldestAgeSeconds: 12.5, deliveredPerSecond: 40, failuresPerSecond: null },
  queues: [{ queue: 'openmap-collector-results', waiting: 3, active: 0, delayed: 0, failed: 1 }],
  slis: [
    { id: 'targets_down', unit: 'count', value: 1, objective: 0, status: 'breach' },
    { id: 'graphql_p95_seconds', unit: 'seconds', value: 0.042, objective: 0.1, status: 'ok' },
    { id: 'graphql_error_ratio', unit: 'ratio', value: null, objective: 0.01, status: 'no_data' },
    { id: 'backup_age_seconds', unit: 'seconds', value: 7200, objective: 93600, status: 'ok' },
  ],
  alerts: [
    { name: 'OpenMapTargetDown', sli: 'targets_down', severity: 'critical', state: 'firing', subject: 'reconciler:4100', activeAt: '2026-11-10T11:55:00.000Z', value: 0 },
    { name: 'OpenMapStoreDown', sli: 'stores_down', severity: 'critical', state: 'pending', subject: 'valkey', activeAt: '2026-11-10T11:59:00.000Z', value: 0 },
  ],
  budgets: {
    configured: true,
    checks: [
      { result: 'screen-interaction', measure: 'p95Ms', page: null, value: 33.7, budget: 100, comparison: 'max', withinBudget: true, measuredAt: '2026-10-22T12:51:08.694Z' },
      { result: 'graph-render', measure: 'fps', page: null, value: 58, budget: 60, comparison: 'min', withinBudget: false, measuredAt: null },
    ],
    invalid: ['broken.json: Unexpected end of JSON input'],
  },
};
let reply: PlatformHealth = health;
const asked: Array<Record<string, unknown>> = [];

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables?: Record<string, unknown> };
      asked.push(body.variables ?? {});
      return Promise.resolve(new Response(JSON.stringify({ data: { platformHealth: reply } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  reply = health;
  roles.current = ['openmap-admin'];
  asked.length = 0;
});

describe.each(LOCALES)('PlatformHealthView (%s)', (locale) => {
  const t = (key: string, params?: Record<string, string | number>) => translate(locale, key as Parameters<typeof translate>[1], params);
  const number = new Intl.NumberFormat(locale);
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const show = () =>
    render(
      <Providers locale={locale}>
        <PlatformHealthView />
      </Providers>,
    );

  it('shows the indicators against their objectives and the alerts, firing first', async () => {
    show();
    const slis = await screen.findByRole('table', { name: t('platform.slis.title') });
    const rows = within(slis).getAllByRole('row').slice(1);
    expect(rows.map((r) => [r.getAttribute('data-sli'), r.getAttribute('data-status')])).toEqual([
      ['targets_down', 'breach'],
      ['graphql_p95_seconds', 'ok'],
      ['graphql_error_ratio', 'no_data'],
      ['backup_age_seconds', 'ok'],
    ]);
    expect(within(rows[1] as HTMLElement).getByText(t('platform.unit.ms', { value: integer.format(42) }))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(t('platform.slis.atMost', { value: t('platform.unit.ms', { value: integer.format(100) }) }))).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText(t('platform.noData'))).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText(t('platform.unit.h', { value: number.format(2) }))).toBeTruthy();
    const alerts = within(screen.getByTestId('platform-alerts')).getAllByRole('listitem');
    expect(alerts.map((a) => a.getAttribute('data-state'))).toEqual(['firing', 'pending']);
    expect(within(alerts[0] as HTMLElement).getByText('reconciler:4100')).toBeTruthy();
    expect(within(alerts[0] as HTMLElement).getByText(t('platform.sli.targets_down'))).toBeTruthy();
    const kpis = screen.getByTestId('platform-kpis');
    expect(within(kpis).getByText(t('platform.kpi.of', { value: integer.format(1), total: integer.format(2) }))).toBeTruthy();
  });

  it('lists targets with their figures, stores, the outbox and the queues', async () => {
    show();
    const targets = await screen.findByRole('table', { name: t('platform.targets.title') });
    const api = within(targets).getAllByRole('row').find((r) => r.getAttribute('data-service') === 'api') as HTMLElement;
    expect(within(api).getByText(t('platform.unit.perSecond', { value: number.format(12.5) }))).toBeTruthy();
    expect(within(api).getByText(t('platform.unit.mib', { value: integer.format(300) }))).toBeTruthy();
    expect(within(api).getByText(t('platform.unit.percent', { value: number.format(0.2) }))).toBeTruthy();
    const reconciler = within(targets).getAllByRole('row').find((r) => r.getAttribute('data-service') === 'reconciler') as HTMLElement;
    expect(reconciler.getAttribute('data-health')).toBe('down');
    expect(within(reconciler).getByText('connection refused')).toBeTruthy();
    const stores = screen.getByRole('list', { name: t('platform.stores.title') });
    expect(within(stores).getAllByRole('listitem').map((s) => [s.getAttribute('data-store'), s.getAttribute('data-up')])).toEqual([
      ['postgres', 'true'],
      ['valkey', 'false'],
      ['openbao', 'null'],
    ]);
    expect(within(stores).getByText(t('platform.store.postgres'))).toBeTruthy();
    const backlog = screen.getByTestId('platform-backlog');
    expect(within(backlog).getByText(integer.format(7))).toBeTruthy();
    expect(within(backlog).getByText(t('platform.unit.s', { value: number.format(12.5) }))).toBeTruthy();
    const queues = within(backlog).getByRole('table', { name: t('platform.queues.title') });
    expect(within(queues).getByText('openmap-collector-results')).toBeTruthy();
  });

  it('shows the perf budgets within and over, with unreadable results named', async () => {
    show();
    const budgets = await screen.findByRole('table', { name: t('platform.budgets.title') });
    const rows = within(budgets).getAllByRole('row').slice(1);
    expect(rows.map((r) => [r.getAttribute('data-result'), r.getAttribute('data-within')])).toEqual([
      ['screen-interaction', 'true'],
      ['graph-render', 'false'],
    ]);
    expect(within(rows[1] as HTMLElement).getByText(t('platform.budgets.over'))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(t('platform.budgets.atLeast', { value: t('platform.unit.fps', { value: number.format(60) }) }))).toBeTruthy();
    expect(screen.getByText('broken.json: Unexpected end of JSON input')).toBeTruthy();
  });

  it('asks for another window when one is chosen', async () => {
    show();
    await screen.findByRole('table', { name: t('platform.slis.title') });
    fireEvent.click(screen.getByRole('radio', { name: t('platform.window.60') }));
    await waitFor(() => {
      expect(asked.some((v) => v['w'] === 60)).toBe(true);
    });
    expect(asked[0]?.['w']).toBe(5);
  });

  it('says when Prometheus is unreachable, and when the deployment keeps no perf results', async () => {
    reply = { ...health, prometheus: { reachable: false, version: null, error: 'fetch failed: ECONNREFUSED' }, budgets: { configured: false, checks: [], invalid: [] } };
    show();
    const banner = await screen.findByTestId('prometheus-unreachable');
    expect(within(banner).getByText(t('platform.prometheus.unreachable'))).toBeTruthy();
    expect(within(banner).getByText('fetch failed: ECONNREFUSED')).toBeTruthy();
    expect(screen.getByText(t('platform.budgets.unconfigured'))).toBeTruthy();
  });

  it('shows non-administrators no platform data', () => {
    roles.current = ['openmap-analyst'];
    show();
    expect(screen.getByText(t('platform.adminOnly'))).toBeTruthy();
    expect(asked).toHaveLength(0);
  });
});
