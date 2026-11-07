// T-481 REQ-BSM-007 REQ-UI-012 (ADR-025) — the Sites screen over stubbed GraphQL, in en and ar:
// - the summary counts;
// - each readiness rule passing or breached, with its findings and incidents;
// - the sites with their DR role and healthy paths;
// - the links with reachability, latency against the commitment, loss and health, and "not probed" for a link
//   without a target.
import { cleanup, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { SitesView } from './SitesView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/en/sites' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const ci = (id: string, type: string, displayName: string, health: string) => ({ id, name: id, displayName, code: id.toUpperCase(), type, layer: 'dc', health });
const ryd = ci('ryd', 'site', 'Riyadh Primary', 'healthy');
const jed = ci('jed', 'site', 'Jeddah DR', 'unknown');
const fibre = ci('fibre', 'site_link', 'RYD to JED fibre', 'down');
const mpls = ci('mpls', 'site_link', 'RYD to JED MPLS', 'healthy');
const plain = ci('plain', 'site_link', 'HQ to RYD', 'unknown');

const connectivity = {
  probeIntervalSeconds: 60,
  sites: [
    { ci: ryd, code: 'RYD', drRole: 'primary', criticality: 1, healthyPaths: 1 },
    { ci: jed, code: 'JED', drRole: 'dr', criticality: 2, healthyPaths: 1 },
  ],
  links: [
    { ci: fibre, fromSite: 'RYD', toSite: 'JED', kind: 'dark_fibre', provider: 'stc', role: 'primary', replication: true, diversePaths: 1, probeTarget: '10.31.0.1:443', reachable: false, latencyMs: null, lossPercent: 100, probedAt: '2026-11-08T00:05:00.000Z', slaLatencyMs: 25 },
    { ci: mpls, fromSite: 'RYD', toSite: 'JED', kind: 'mpls', provider: 'Mobily', role: 'backup', replication: false, diversePaths: 1, probeTarget: '10.31.0.2:443', reachable: true, latencyMs: 18.5, lossPercent: 0, probedAt: '2026-11-08T00:05:00.000Z', slaLatencyMs: 38 },
    { ci: plain, fromSite: 'HQ', toSite: 'RYD', kind: 'mpls', provider: 'stc', role: 'primary', replication: false, diversePaths: 2, probeTarget: null, reachable: null, latencyMs: null, lossPercent: null, probedAt: null, slaLatencyMs: null },
  ],
  findings: [
    { id: 'f1', rule: 'replication_healthy', detail: 'Replication link RYD to JED fibre is down.', state: 'open', openedAt: '2026-11-08T00:05:00.000Z', clearedAt: null, subject: fibre, incident: { id: 'i1', title: 'Readiness: Replication link RYD to JED fibre is down.', state: 'open', severity: 'medium' } },
    { id: 'f2', rule: 'diverse_paths', detail: 'Riyadh Primary has 1 healthy path(s); 2 are required.', state: 'open', openedAt: '2026-11-08T00:05:00.000Z', clearedAt: null, subject: ryd, incident: null },
  ],
};

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: { connectivity } }), { status: 200, headers: { 'content-type': 'application/json' } }))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('SitesView in %s', (locale) => {
  it('shows the readiness rules, the sites and the links with their probe figures', async () => {
    const n = (v: number) => new Intl.NumberFormat(locale).format(v);
    render(
      <Providers locale={locale}>
        <SitesView locale={locale} />
      </Providers>,
    );
    const readiness = await screen.findByRole('region', { name: translate(locale, 'sites.readiness') });
    // Two rules breached, the DR rule passing.
    expect(within(readiness).getAllByText(translate(locale, 'sites.breached', { count: n(1) }))).toHaveLength(2);
    expect(within(readiness).getByText(translate(locale, 'sites.passing'))).toBeTruthy();
    const replication = within(readiness).getByRole('list', { name: translate(locale, 'sites.rule.replication_healthy') });
    expect(within(replication).getByRole('link', { name: 'RYD to JED fibre' })).toBeTruthy();
    expect(within(replication).getByText(translate(locale, 'sites.finding.incident', { title: 'Readiness: Replication link RYD to JED fibre is down.' }))).toBeTruthy();

    const summary = screen.getByRole('group', { name: translate(locale, 'sites.summary') });
    expect(within(summary).getByText(translate(locale, 'sites.summary.openFindings')).parentElement?.textContent).toContain(n(2));

    const sites = screen.getByRole('table', { name: translate(locale, 'sites.sites') });
    expect(within(sites).getByText(translate(locale, 'sites.drRole.dr'))).toBeTruthy();
    expect(within(sites).getByRole('link', { name: 'Riyadh Primary' })).toBeTruthy();

    const links = screen.getByRole('table', { name: translate(locale, 'sites.links') });
    const mplsRow = within(links).getByRole('link', { name: 'RYD to JED MPLS' }).closest('tr');
    if (mplsRow === null) throw new Error('no MPLS row');
    expect(within(mplsRow).getByText(translate(locale, 'sites.ms', { value: n(18.5) }))).toBeTruthy();
    expect(within(mplsRow).getByText(translate(locale, 'sites.committed', { value: translate(locale, 'sites.ms', { value: n(38) }) }))).toBeTruthy();
    expect(within(links).getByText(translate(locale, 'sites.replication'))).toBeTruthy();
    expect(within(links).getByText(translate(locale, 'sites.notProbed'))).toBeTruthy();
    expect(within(links).getAllByText(translate(locale, 'health.down')).length).toBeGreaterThan(0);
  });
});
