// T-593 REQ-IPAM-007 (ADR-069) — the network circuit register on the Sites screen over stubbed GraphQL, in en and ar:
// - the path_diversity and redundancy_lost rules are listed with their findings;
// - a link shows its carrier contract, physical route, the carrier circuits it rides on with their health, and what it
//   shares with the other link between the same sites;
// - an operator opens a link's circuit details, changes the contract, route and committed latency, puts the link on a
//   second carrier circuit and saves: saveLinkCircuit receives the whole register entry.
// The draft helpers keep a required figure required and leave optional text empty as null.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectivityLink } from '@/lib/queries';
import { Providers } from '@/providers';
import { draftOf, inputOf } from './LinkCircuitForm';
import { SitesView } from './SitesView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/sites',
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCan: () => () => true,
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const ci = (id: string, type: string, displayName: string, health: string) => ({
  id,
  name: id,
  displayName,
  code: id.toUpperCase(),
  type,
  layer: 'network_security',
  health,
});
const fibre = ci('11111111-1111-4111-8111-111111111111', 'site_link', 'RYD to JED fibre', 'down');
const mpls = ci('22222222-2222-4222-8222-222222222222', 'site_link', 'RYD to JED MPLS', 'healthy');
const loop = ci('33333333-3333-4333-8333-333333333333', 'circuit', 'stc LOOP-1', 'down');
const backbone = ci('44444444-4444-4444-8444-444444444444', 'circuit', 'stc BB-7', 'healthy');
const base = {
  fromSite: 'RYD',
  toSite: 'JED',
  replication: false,
  diversePaths: 1,
  probeTarget: null,
  reachable: null,
  latencyMs: null,
  lossPercent: null,
  probedAt: null,
  throughputMbps: null,
  utilisationPercent: null,
  redundancy: 'degraded',
};
const fibreLink = {
  ...base,
  ci: fibre,
  kind: 'dark_fibre',
  provider: 'stc',
  role: 'primary',
  slaLatencyMs: 12,
  capacityMbps: 100000,
  carrierContractRef: 'CTR-STC-001',
  pathRef: 'North duct',
  circuits: [{ ci: loop, provider: 'stc', circuitId: 'LOOP-1', status: 'active' }],
  sharedRisks: [{ kind: 'provider', value: 'STC', other: mpls }],
};
const mplsLink = {
  ...base,
  ci: mpls,
  kind: 'mpls',
  provider: 'STC',
  role: 'backup',
  slaLatencyMs: null,
  capacityMbps: 10000,
  carrierContractRef: null,
  pathRef: null,
  circuits: [],
  sharedRisks: [{ kind: 'provider', value: 'stc', other: fibre }],
};
const connectivity = {
  probeIntervalSeconds: 60,
  sites: [],
  links: [fibreLink, mplsLink],
  findings: [
    {
      id: 'f1',
      rule: 'path_diversity',
      detail: 'RYD to JED MPLS shares provider stc with RYD to JED fibre: they are not diverse paths.',
      state: 'open',
      openedAt: '2026-11-10T00:05:00.000Z',
      clearedAt: null,
      subject: mpls,
      incident: null,
    },
    {
      id: 'f2',
      rule: 'redundancy_lost',
      detail: 'RYD to JED fibre is down; RYD-JED has 1 of 2 paths up.',
      state: 'open',
      openedAt: '2026-11-10T00:05:00.000Z',
      clearedAt: null,
      subject: fibre,
      incident: { id: 'i2', title: 'Readiness: RYD to JED fibre is down', state: 'open', severity: 'medium' },
    },
  ],
};
const cabling = {
  summary: { patchPanels: 0, positions: 0, positionsUsed: 0, cables: 0, crossConnects: 0, circuits: 2 },
  patchPanels: [],
  cables: [],
  circuits: [
    {
      ci: { id: loop.id },
      provider: 'stc',
      circuitId: 'LOOP-1',
      kind: 'dark_fibre',
      status: 'active',
      bandwidthMbps: 100000,
      aEnd: null,
      zEnd: null,
      zEndDescription: null,
    },
    {
      ci: { id: backbone.id },
      provider: 'stc',
      circuitId: 'BB-7',
      kind: 'mpls',
      status: 'active',
      bandwidthMbps: 100000,
      aEnd: null,
      zEnd: null,
      zEndDescription: null,
    },
  ],
};

let saved: Array<{ linkId: string; input: Record<string, unknown> }> = [];
const json = (data: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );

beforeEach(() => {
  saved = [];
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        query: string;
        variables?: { linkId: string; input: Record<string, unknown> };
      };
      if (body.query.includes('SaveLinkCircuit') && body.variables !== undefined) {
        saved.push(body.variables);
        return json({ saveLinkCircuit: fibreLink });
      }
      if (body.query.includes('query Cabling')) return json({ cabling });
      return json({ connectivity });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('circuit register drafts', () => {
  it('round-trips a link and refuses missing figures', () => {
    const draft = draftOf(fibreLink as ConnectivityLink);
    expect(inputOf(draft)).toEqual({
      kind: 'dark_fibre',
      provider: 'stc',
      carrierContractRef: 'CTR-STC-001',
      bandwidthMbps: 100000,
      slaLatencyMs: 12,
      diversePaths: 1,
      role: 'primary',
      pathRef: 'North duct',
      circuitCiIds: [loop.id],
    });
    expect(inputOf({ ...draft, bandwidthMbps: '' })).toBeNull();
    expect(inputOf({ ...draft, slaLatencyMs: 'soon' })).toBeNull();
    expect(inputOf({ ...draft, carrierContractRef: '  ', slaLatencyMs: '' })).toMatchObject({
      carrierContractRef: null,
      slaLatencyMs: null,
    });
  });
});

describe.each(LOCALES)('circuit register on the Sites screen in %s', (locale) => {
  it('shows circuits and shared risks, and saves an operator edit', async () => {
    render(
      <Providers locale={locale}>
        <SitesView locale={locale} />
      </Providers>,
    );
    const readiness = await screen.findByRole('region', { name: translate(locale, 'sites.readiness') });
    expect(within(readiness).getByText(translate(locale, 'sites.rule.path_diversity'))).toBeTruthy();
    const lost = within(readiness).getByRole('list', {
      name: translate(locale, 'sites.rule.redundancy_lost'),
    });
    expect(within(lost).getByRole('link', { name: 'RYD to JED fibre' })).toBeTruthy();
    expect(
      within(lost).getByText(
        translate(locale, 'sites.finding.incident', { title: 'Readiness: RYD to JED fibre is down' }),
      ),
    ).toBeTruthy();

    const links = screen.getByRole('table', { name: translate(locale, 'sites.links') });
    const fibreRow = within(links).getByRole('link', { name: 'RYD to JED fibre' }).closest('tr');
    if (fibreRow === null) throw new Error('no fibre row');
    expect(
      within(fibreRow).getByText(translate(locale, 'sites.circuit.contract', { ref: 'CTR-STC-001' })),
    ).toBeTruthy();
    expect(
      within(fibreRow).getByText(translate(locale, 'sites.circuit.route', { ref: 'North duct' })),
    ).toBeTruthy();
    expect(
      within(within(fibreRow).getByLabelText(translate(locale, 'sites.circuit.carriers'))).getByText(
        'stc LOOP-1',
      ),
    ).toBeTruthy();
    expect(
      within(fibreRow).getByText(
        translate(locale, 'sites.circuit.shares.provider', { value: 'STC', link: 'RYD to JED MPLS' }),
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', {
        name: translate(locale, 'sites.circuit.edit', { link: 'RYD to JED fibre' }),
      }),
    );
    const form = await screen.findByRole('form', {
      name: translate(locale, 'sites.circuit.form', { link: 'RYD to JED fibre' }),
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'setup.links.contract')), {
      target: { value: 'CTR-STC-009' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'setup.links.pathRef')), {
      target: { value: 'West duct' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'setup.links.slaLatency')), {
      target: { value: '10' },
    });
    const second = await within(form).findByLabelText(
      translate(locale, 'sites.circuit.option', { provider: 'stc', circuit: 'BB-7' }),
    );
    fireEvent.click(second);
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'sites.circuit.save') }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toEqual({
      linkId: fibre.id,
      input: {
        kind: 'dark_fibre',
        provider: 'stc',
        carrierContractRef: 'CTR-STC-009',
        bandwidthMbps: 100000,
        slaLatencyMs: 10,
        diversePaths: 1,
        role: 'primary',
        pathRef: 'West duct',
        circuitCiIds: [loop.id, backbone.id],
      },
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('form', {
          name: translate(locale, 'sites.circuit.form', { link: 'RYD to JED fibre' }),
        }),
      ).toBeNull();
    });
  });
});
