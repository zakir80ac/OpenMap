// T-114 REQ-CMDB-038 REQ-UI-008 — CmdbView lists CIs with the layer's headline metric on every row: the contract
// label through i18n, the value with the contract unit, and an explicit "no sample" state, in en and ar over
// stubbed GraphQL.
import { cleanup, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { CmdbView } from './CmdbView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/cmdb',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// jsdom gives the scroll container no height, so the virtualiser would render no row; the test renders them all.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * estimateSize(), size: estimateSize() })),
  }),
}));

vi.mock('@/hooks/useLayerVisibility', () => ({
  useLayerVisibility: () => ({
    visibility: Object.fromEntries(
      ['dc', 'network_security', 'hardware', 'storage', 'virtualization', 'cloud', 'os', 'containers', 'databases', 'applications', 'saas', 'unknown'].map((l) => [l, true]),
    ),
    visibleCount: 12,
  }),
}));

const observedAt = '2026-10-22T09:12:00.000Z';
const rows = [
  {
    id: 'host-1',
    code: 'SRV-DB-RYD-PG-CORE-01',
    type: 'host',
    layer: 'hardware',
    displayName: 'db-ryd-pg-core-01',
    health: 'healthy',
    observedAt,
    headlineMetric: { key: 'cpuPercent', label: 'Host load', unit: '%', metric: 'host.cpu.utilisation_percent', value: 41.5, observedAt },
  },
  {
    id: 'db-1',
    code: 'DB-LEDGER',
    type: 'database_cluster',
    layer: 'databases',
    displayName: 'Ledger DB',
    health: 'degraded',
    observedAt,
    headlineMetric: { key: 'iops', label: 'IOPS', unit: '', metric: 'db.instance.iops', value: null, observedAt: null },
  },
  {
    id: 'unk-1',
    code: 'UNK-10-20-4-99',
    type: 'unknown',
    layer: 'unknown',
    displayName: '10.20.4.99',
    health: 'unknown',
    observedAt,
    headlineMetric: { key: 'lastSeenDays', label: 'Last seen', unit: 'd', metric: 'discovery.last_seen.days', value: 3, observedAt },
  },
];

const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  calls.push({ query: body.query, variables: body.variables ?? {} });
  if (body.query.includes('query Cis('))
    return {
      data: {
        cis: {
          totalCount: rows.length,
          pageInfo: { endCursor: null, hasNextPage: false },
          edges: rows.map((node) => ({ cursor: node.id, node })),
        },
      },
    };
  return { errors: [{ message: 'unexpected operation' }] };
}

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(raw) as { query: string; variables?: Record<string, unknown> };
      return Promise.resolve(new Response(JSON.stringify(respond(body)), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('CmdbView in %s', (locale) => {
  it('shows the headline metric column with value and unit, and says when a CI has no sample yet', async () => {
    calls.length = 0;
    render(
      <Providers locale={locale}>
        <CmdbView text="" />
      </Providers>,
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: translate(locale, 'cmdb.column.metric') })).toBeTruthy();
    expect(await within(table).findByText('SRV-DB-RYD-PG-CORE-01')).toBeTruthy();
    expect(calls[0]?.query).toContain('headlineMetric { key label unit metric value observedAt }');

    const host = within(table).getByText('db-ryd-pg-core-01').closest('[role="row"]');
    if (host === null) throw new Error('host row missing');
    const hostMetric = within(host as HTMLElement).getByText(translate(locale, 'metric.cpuPercent')).parentElement;
    expect(hostMetric?.getAttribute('data-metric')).toBe('host.cpu.utilisation_percent');
    expect(hostMetric?.textContent).toContain(new Intl.NumberFormat(locale).format(41.5) + ' %');

    const db = within(table).getByText('Ledger DB').closest('[role="row"]');
    if (db === null) throw new Error('database row missing');
    expect(within(db as HTMLElement).getByText(translate(locale, 'metric.iops'))).toBeTruthy();
    expect(within(db as HTMLElement).getByText(translate(locale, 'metric.noSample'))).toBeTruthy();

    const unknown = within(table).getByText('10.20.4.99').closest('[role="row"]');
    if (unknown === null) throw new Error('unknown row missing');
    expect(within(unknown as HTMLElement).getByText(translate(locale, 'metric.lastSeenDays'))).toBeTruthy();
    expect(within(unknown as HTMLElement).getByText(new Intl.NumberFormat(locale).format(3) + ' d')).toBeTruthy();
  });
});
