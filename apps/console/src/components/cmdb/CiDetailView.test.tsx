// T-063 REQ-UI-008 REQ-CMDB-037 REQ-CMDB-012 — CiDetailView renders header, tabs, formatted attributes, grouped
// relationships, the time-travel diff and the label panel for unknown CIs, in en and ar, over stubbed GraphQL.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/auth')>()), useCan: () => () => true }));

import { Providers } from '@/providers';
import { CiDetailView } from './CiDetailView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/cmdb/host-1',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const summary = (id: string, layer: string, type: string, displayName: string) => ({ id, name: id, displayName, type, layer, health: 'healthy' });

const now = {
  ...summary('host-1', 'hardware', 'host', 'db-ryd-pg-core-01'),
  name: 'db-ryd-pg-core-01.bank.local',
  health: 'down',
  identity: { serialNumber: '7KQ2M93', fqdn: 'db-ryd-pg-core-01.bank.local' },
  attributes: { cores: 64, osVersion: 'Ubuntu 24.04', firmwareUpdatedAt: '2026-09-03T02:00:00.000Z', nics: ['eno1', 'eno2'], virtual: false, rack: 'R12' },
  tags: ['core-banking', 'tier-1'],
  externalIds: [{ source: 'servicenow', id: 'CI0012345' }],
  lifecycle: 'managed',
  userLabel: null,
  source: { collectorId: 'ssh_agentless', nodeId: 'node-ryd-1', runId: 'run-77', confidence: 0.98 },
  observedAt: '2026-10-22T09:12:00.000Z',
  validFrom: '2026-09-03T02:00:00.000Z',
  validTo: null,
  relationships: {
    totalCount: 3,
    edges: [
      { node: { id: 'r1', type: 'powered_by', from: summary('host-1', 'hardware', 'host', 'db-ryd-pg-core-01'), to: summary('pdu-a', 'dc', 'pdu', 'PDU-R12-A'), validFrom: '2026-03-02T00:00:00.000Z', validTo: null } },
      { node: { id: 'r2', type: 'powered_by', from: summary('host-1', 'hardware', 'host', 'db-ryd-pg-core-01'), to: summary('pdu-b', 'dc', 'pdu', 'PDU-R12-B'), validFrom: '2026-03-02T00:00:00.000Z', validTo: null } },
      { node: { id: 'r3', type: 'runs_on', from: summary('db-1', 'databases', 'database', 'pg-core-01'), to: summary('host-1', 'hardware', 'host', 'db-ryd-pg-core-01'), validFrom: '2026-03-02T00:00:00.000Z', validTo: null } },
    ],
  },
};

const then = { ...now, attributes: { cores: 64, osVersion: 'Ubuntu 22.04', nics: ['eno1', 'eno2'], virtual: false, rack: 'R9' }, validFrom: '2026-03-02T00:00:00.000Z' };

const unknown = { ...now, id: 'unk-1', layer: 'unknown', type: 'unknown', displayName: '10-20-4-99', relationships: { totalCount: 0, edges: [] } };

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  if (body.query.includes('query CiDetail(')) {
    const id = body.variables?.['id'];
    if (id === 'unk-1') return { data: { ci: unknown } };
    if (id === 'missing') return { data: { ci: null } };
    return { data: { ci: body.variables?.['asOf'] === null || body.variables?.['asOf'] === undefined ? now : then } };
  }
  if (body.query.includes('query Impact(')) return { data: { impact: { root: summary('host-1', 'hardware', 'host', 'x'), nodes: [{}, {}], services: [{}], durationMs: 12 } } };
  if (body.query.includes('mutation LabelCi(')) return { data: { labelCi: { ...summary('unk-1', 'network_security', 'network_device', 'Edge switch'), health: 'unknown' } } };
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

describe.each(LOCALES)('CiDetailView in %s', (locale) => {
  it('renders the header with code, badges and formatted attributes', async () => {
    render(
      <Providers locale={locale}>
        <CiDetailView locale={locale} id="host-1" />
      </Providers>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'db-ryd-pg-core-01' })).toBeTruthy();
    expect(screen.getByText('SRV-DB-RYD-PG-CORE-01')).toBeTruthy();
    expect(screen.getByText(translate(locale, 'health.down'))).toBeTruthy();
    expect(screen.getByText(translate(locale, 'lifecycle.managed'))).toBeTruthy();
    expect(screen.getByText(new Intl.NumberFormat(locale).format(64))).toBeTruthy();
    expect(screen.getByText(translate(locale, 'common.no'))).toBeTruthy();
    expect(screen.getByText('eno2')).toBeTruthy();
    expect(screen.getByText('CI0012345')).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: translate(locale, 'cmdb.detail.tabs') });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(4);
  });

  it('groups relationships by type with links to the other CI', async () => {
    render(
      <Providers locale={locale}>
        <CiDetailView locale={locale} id="host-1" />
      </Providers>,
    );
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(translate(locale, 'cmdb.detail.tab.relationships')) }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(translate(locale, 'relationship.powered_by'))).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'PDU-R12-B' }).getAttribute('href')).toBe('/' + locale + '/cmdb/pdu-b');
    expect(within(panel).getByRole('link', { name: 'pg-core-01' })).toBeTruthy();
    expect(within(panel).getAllByText(translate(locale, 'cmdb.detail.relationships.outgoing'))).toHaveLength(2);
  });

  it('shows upstream and downstream counts linking into the dependency map', async () => {
    render(
      <Providers locale={locale}>
        <CiDetailView locale={locale} id="host-1" />
      </Providers>,
    );
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: translate(locale, 'cmdb.detail.tab.impact') }));
    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: translate(locale, 'cmdb.detail.impact.open') })).toHaveLength(2);
    });
    const links = screen.getAllByRole('link', { name: translate(locale, 'cmdb.detail.impact.open') });
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/' + locale + '/dependencies?ci=host-1', '/' + locale + '/dependencies?ci=host-1&direction=downstream']);
    expect(screen.getAllByText(translate(locale, 'cmdb.detail.impact.nodes', { count: new Intl.NumberFormat(locale).format(2) }))).toHaveLength(2);
  });

  it('diffs attributes against an earlier version in the History tab', async () => {
    render(
      <Providers locale={locale}>
        <CiDetailView locale={locale} id="host-1" />
      </Providers>,
    );
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: translate(locale, 'cmdb.detail.tab.history') }));
    expect(screen.getByText(translate(locale, 'cmdb.detail.history.pick'))).toBeTruthy();
    const input = screen.getByLabelText(translate(locale, 'cmdb.detail.history.asOf'));
    fireEvent.change(input, { target: { value: '2026-06-01T08:00' } });
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeTruthy();
    });
    const table = screen.getByRole('table');
    expect(within(table).getByText('firmwareUpdatedAt')).toBeTruthy();
    expect(within(table).getByText('Ubuntu 22.04')).toBeTruthy();
    expect(within(table).getByText('Ubuntu 24.04')).toBeTruthy();
    expect(within(table).getByText('R9')).toBeTruthy();
    expect(within(table).queryByText('cores')).toBeNull();
    expect(within(table).getAllByText(translate(locale, 'cmdb.detail.history.change.changed'))).toHaveLength(2);
  });

  it('offers the label panel for an unknown CI and submits labelCi', async () => {
    render(
      <Providers locale={locale}>
        <CiDetailView locale={locale} id="unk-1" />
      </Providers>,
    );
    await screen.findByRole('heading', { level: 1, name: '10-20-4-99' });
    const form = screen.getByText(translate(locale, 'cmdb.detail.label.title')).closest('section');
    expect(form).not.toBeNull();
    const layer = within(form as HTMLElement).getByLabelText(translate(locale, 'cmdb.detail.label.layer'));
    fireEvent.change(layer, { target: { value: 'network_security' } });
    const type = within(form as HTMLElement).getByLabelText<HTMLSelectElement>(translate(locale, 'cmdb.detail.label.type'));
    expect([...type.options].map((o) => o.value)).toContain('network_device');
    expect([...type.options].map((o) => o.value)).not.toContain('host');
    fireEvent.click(within(form as HTMLElement).getByRole('button', { name: translate(locale, 'cmdb.detail.label.submit') }));
    await waitFor(() => {
      expect(screen.getByText(translate(locale, 'cmdb.detail.label.saved', { layer: translate(locale, 'layer.network_security') }))).toBeTruthy();
    });
  });

  it('explains a missing id', async () => {
    render(
      <Providers locale={locale}>
        <CiDetailView locale={locale} id="missing" />
      </Providers>,
    );
    expect(await screen.findByText(translate(locale, 'cmdb.detail.notFound', { id: 'missing' }))).toBeTruthy();
  });
});
