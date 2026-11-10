// T-635 REQ-INT-012 (ADR-073) — the Monitoring events screen over stubbed GraphQL, in en and ar:
// - the address each monitoring integration receives events at, the firing / unresolved / mapped counts;
// - each alert with its state, severity, vendor, the CI it was matched to (and how) or "no CI found", its targets;
// - an operator maps an unresolved alert's source to a CI found by search, and clears a firing alert.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { MonitoringEventsView } from './MonitoringEventsView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/en/integrations/monitoring' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<object>()), useCan: () => () => true }));

const INTEGRATION = '0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const ci = (id: string, displayName: string) => ({ id, name: displayName, displayName, code: id.toUpperCase(), type: 'host', layer: 'hardware', health: 'down' });
const base = { integrationId: INTEGRATION, integrationName: 'Prod Alertmanager', vendor: 'prometheus_alertmanager', description: null, sourceUrl: null, endsAt: null, expiresAt: null, firstReceivedAt: '2026-11-10T11:55:00.000Z', lastReceivedAt: '2026-11-10T11:58:00.000Z', receivedCount: 3 };
const report = {
  firing: 2,
  unresolved: 1,
  mappings: [{ id: 'm1', sourceKey: 'legacy-box', ci: ci('ci3', 'legacy-box.lab.test'), createdBy: 'ops', createdAt: '2026-11-09T10:00:00.000Z' }],
  alerts: [
    { ...base, id: 'a1', fingerprint: 'f1', status: 'firing', severity: 'critical', effect: 'down', title: 'NodeDown: web-01 unreachable', targets: [{ kind: 'instance', value: 'web-01.lab.test' }], ci: ci('ci1', 'web-01'), resolution: 'identity', startsAt: '2026-11-10T11:55:00.000Z' },
    { ...base, id: 'a2', fingerprint: 'f2', vendor: 'solarwinds', integrationName: 'Orion', status: 'firing', severity: 'high', effect: 'down', title: 'Node is down: edge-rtr-02', targets: [{ kind: 'ip', value: '10.9.0.1' }, { kind: 'hostname', value: 'edge-rtr-02' }], ci: null, resolution: null, startsAt: '2026-11-10T11:50:00.000Z' },
  ],
};
const sent: Array<{ query: string; variables: Record<string, unknown> | undefined }> = [];

beforeEach(() => {
  sent.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { query: string; variables?: Record<string, unknown> };
      sent.push({ query: body.query, variables: body.variables });
      const data = body.query.includes('mapMonitoringSource')
        ? { mapMonitoringSource: { id: 'm2', sourceKey: 'edge-rtr-02', ci: ci('ci2', 'edge-rtr-02.lab.test'), createdBy: 'ops', createdAt: '2026-11-10T12:00:00.000Z' } }
        : body.query.includes('clearMonitoringAlert')
          ? { clearMonitoringAlert: { ...report.alerts[0], status: 'resolved' } }
          : body.query.includes('search(')
            ? { search: [{ ci: ci('ci2', 'edge-rtr-02.lab.test'), score: 1, highlight: null }] }
            : body.query.includes('integrations(')
              ? { integrations: [{ id: INTEGRATION, category: 'monitoring', vendor: 'prometheus_alertmanager', name: 'Prod Alertmanager', enabled: true, direction: 'inbound', health: 'healthy', lastSuccessAt: null, lastError: null, deliveredLastHour: 3, failedLastHour: 0 }] }
              : { monitoringAlerts: report };
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('MonitoringEventsView in %s', (locale) => {
  it('lists alerts with their CI or "no CI found", the ingest address and the counts', async () => {
    render(
      <Providers locale={locale}>
        <MonitoringEventsView />
      </Providers>,
    );
    const list = await screen.findByRole('list', { name: translate(locale, 'monitoring.list') });
    const resolved = within(list).getByRole('listitem', { name: 'NodeDown: web-01 unreachable' });
    expect(within(resolved).getByRole('link', { name: 'web-01' })).toBeTruthy();
    expect(within(resolved).getByText(translate(locale, 'monitoring.resolution.identity'))).toBeTruthy();
    expect(within(resolved).getByText(translate(locale, 'monitoring.severity.critical'))).toBeTruthy();
    expect(within(resolved).getByText(translate(locale, 'monitoring.effect.down'))).toBeTruthy();
    const unresolved = within(list).getByRole('listitem', { name: 'Node is down: edge-rtr-02' });
    expect(within(unresolved).getByText(translate(locale, 'monitoring.unresolved'))).toBeTruthy();
    expect(within(unresolved).getByText(translate(locale, 'monitoring.vendor.solarwinds') + ' · Orion')).toBeTruthy();
    expect(within(within(unresolved).getByLabelText(translate(locale, 'monitoring.targets'))).getByText('10.9.0.1')).toBeTruthy();
    const summary = screen.getByRole('group', { name: translate(locale, 'monitoring.summary') });
    expect(within(summary).getByText(translate(locale, 'monitoring.kpi.unresolved')).parentElement?.textContent).toContain(new Intl.NumberFormat(locale).format(1));
    expect(await screen.findByText('http://api.test/ingest/monitoring/' + INTEGRATION)).toBeTruthy();
    expect(screen.getByRole('table', { name: translate(locale, 'monitoring.mappings.title') }).textContent).toContain('legacy-box');
  });

  it('maps an unresolved source to a CI found by search, and clears a firing alert', async () => {
    render(
      <Providers locale={locale}>
        <MonitoringEventsView />
      </Providers>,
    );
    const list = await screen.findByRole('list', { name: translate(locale, 'monitoring.list') });
    const unresolved = within(list).getByRole('listitem', { name: 'Node is down: edge-rtr-02' });
    expect(within(within(list).getByRole('listitem', { name: 'NodeDown: web-01 unreachable' })).queryByRole('button', { name: translate(locale, 'monitoring.map') })).toBeNull();
    fireEvent.click(within(unresolved).getByRole('button', { name: translate(locale, 'monitoring.map') }));
    const form = within(unresolved).getByRole('form', { name: translate(locale, 'monitoring.map') });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'monitoring.map.key')), { target: { value: 'edge-rtr-02' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'monitoring.map.search')), { target: { value: 'edge' } });
    fireEvent.click(await within(form).findByRole('button', { name: translate(locale, 'monitoring.map.to', { name: 'edge-rtr-02.lab.test' }) }));
    await waitFor(() => {
      expect(sent.find((s) => s.query.includes('mapMonitoringSource'))?.variables).toEqual({ sourceKey: 'edge-rtr-02', ciId: 'ci2' });
    });

    const first = within(list).getByRole('listitem', { name: 'NodeDown: web-01 unreachable' });
    fireEvent.click(within(first).getByRole('button', { name: translate(locale, 'monitoring.clear') }));
    await waitFor(() => {
      expect(sent.find((s) => s.query.includes('clearMonitoringAlert'))?.variables).toEqual({ id: 'a1' });
    });
  });
});
