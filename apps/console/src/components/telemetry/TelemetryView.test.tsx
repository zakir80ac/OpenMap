// T-496 REQ-UI-027 — the Health and telemetry fleet table over stubbed GraphQL, in en and ar:
// - each row with its CI, category and site, address, health, CPU, memory, IOPS, throughput and Apdex;
// - the health pills carry the counts, and choosing one sends the health filter;
// - a category pill sends the layer filter, and a column header changes the sort.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { TelemetryView } from './TelemetryView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/en/telemetry' }));
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

const ci = (id: string, type: string, layer: string, displayName: string, health: string) => ({ id, name: id, displayName, code: id.toUpperCase(), type, layer, health });
const page = {
  total: 3,
  healthy: 1,
  degraded: 1,
  down: 1,
  unknown: 0,
  asOf: '2026-11-08T06:00:00.000Z',
  items: [
    { ci: ci('esx-01', 'host', 'hardware', 'esx-ryd-c01-01', 'down'), site: 'RYD', address: 'esx-ryd-c01-01.bank.local', health: 'down', cpu: 88.5, memory: 71, iops: null, throughput: null, apdex: null, observedAt: '2026-11-08T05:59:00.000Z' },
    { ci: ci('sw-01', 'network_device', 'network_security', 'core-sw-ryd-01', 'degraded'), site: 'RYD', address: '10.15.0.2', health: 'degraded', cpu: null, memory: null, iops: null, throughput: 6.3, apdex: null, observedAt: '2026-11-08T05:59:00.000Z' },
    { ci: ci('app-01', 'application', 'applications', 'Core banking', 'healthy'), site: 'RYD', address: null, health: 'healthy', cpu: null, memory: null, iops: null, throughput: null, apdex: 0.96, observedAt: '2026-11-08T05:59:00.000Z' },
  ],
};

const calls: Array<{ filter: unknown; sort: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { variables: { filter: unknown; sort: unknown } };
      calls.push({ filter: body.variables.filter, sort: body.variables.sort });
      return Promise.resolve(new Response(JSON.stringify({ data: { telemetryFleet: page } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('TelemetryView in %s', (locale) => {
  it('lists the fleet with its measurements and sends the filters and sort', async () => {
    const n = (v: number) => new Intl.NumberFormat(locale).format(v);
    render(
      <Providers locale={locale}>
        <TelemetryView />
      </Providers>,
    );
    const table = await screen.findByRole('table', { name: translate(locale, 'telemetry.table') });
    const host = (await within(table).findByRole('link', { name: 'esx-ryd-c01-01' })).closest('[role="row"]');
    if (!(host instanceof HTMLElement)) throw new Error('no host row');
    expect(within(host).getByText(translate(locale, 'telemetry.percent', { value: n(88.5) }))).toBeTruthy();
    expect(within(host).getByText(translate(locale, 'telemetry.percent', { value: n(71) }))).toBeTruthy();
    expect(within(host).getByText('esx-ryd-c01-01.bank.local')).toBeTruthy();
    expect(within(host).getAllByText('RYD').length).toBeGreaterThan(0);
    const sw = within(table).getByRole('link', { name: 'core-sw-ryd-01' }).closest('[role="row"]');
    if (!(sw instanceof HTMLElement)) throw new Error('no switch row');
    expect(within(sw).getByText(translate(locale, 'telemetry.gbps', { value: n(6.3) }))).toBeTruthy();
    const app = within(table).getByRole('link', { name: 'Core banking' }).closest('[role="row"]');
    if (!(app instanceof HTMLElement)) throw new Error('no application row');
    expect(within(app).getByText(n(0.96))).toBeTruthy();
    expect(screen.getByText(translate(locale, 'telemetry.total', { count: n(3) }))).toBeTruthy();
    expect(calls[0]).toEqual({ filter: {}, sort: 'health' });

    const healthGroup = screen.getByRole('group', { name: translate(locale, 'telemetry.filter.health') });
    fireEvent.click(within(healthGroup).getByText(translate(locale, 'telemetry.healthCount', { health: translate(locale, 'health.down'), count: n(1) })));
    await waitFor(() => {
      expect(calls.at(-1)).toEqual({ filter: { health: ['down'] }, sort: 'health' });
    });
    const categories = screen.getByRole('group', { name: translate(locale, 'telemetry.filter.category') });
    fireEvent.click(within(categories).getByText(translate(locale, 'layer.network_security')));
    await waitFor(() => {
      expect(calls.at(-1)).toEqual({ filter: { health: ['down'], layers: ['network_security'] }, sort: 'health' });
    });
    fireEvent.click(within(table).getByRole('button', { name: translate(locale, 'telemetry.column.cpu') }));
    await waitFor(() => {
      expect(calls.at(-1)?.sort).toBe('cpu');
    });
  });
});
