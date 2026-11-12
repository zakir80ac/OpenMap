// T-120 REQ-UI-029 — TwinView builds the facility from the racks query, lays a focus CI's impact graph on the layer
// planes, hands the models to the scene, and shows the selected rack's devices and the selected node's CI, in en
// and ar. The WebGL scene is replaced by a probe that reports what it received, since jsdom has no GPU.
// T-661 REQ-UI-037 — the drill-down: a device picked from the open rack is selected in the scene and drilled into
// (components, compute, OS, network, security with its CVEs, and the services the upstream walk reached), a neighbour
// drills one level further, and the breadcrumb returns to the rack.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TwinSceneProps } from './TwinScene';

const sceneProps: TwinSceneProps[] = [];
vi.mock('./TwinSceneLazy', () => ({
  TwinSceneLazy: (props: TwinSceneProps) => {
    sceneProps.push(props);
    return (
      <div data-testid="scene-probe" data-racks={props.facility.racks.length} data-nodes={props.graph?.nodes.length ?? 0} data-planes={props.graph?.planes.length ?? 0}>
        {props.facility.racks.map((rack) => (
          <button key={rack.id} type="button" data-testid={'probe-rack-' + rack.id} onClick={() => { props.onSelect({ kind: 'rack', id: rack.id }); }}>
            {props.rackCaption(rack)}
          </button>
        ))}
        {(props.graph?.nodes ?? []).map((node) => (
          <button key={node.id} type="button" data-testid={'probe-node-' + node.id} onClick={() => { props.onSelect({ kind: 'node', id: node.id }); }}>
            {node.label}
          </button>
        ))}
      </div>
    );
  },
}));

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/en/twin',
  useSearchParams: () => new URLSearchParams(search),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { Providers } from '@/providers';
import { TwinView } from './TwinView';

const ci = (id: string, displayName: string, layer: string, type: string, attributes: Record<string, unknown> = {}) => ({ id, name: id, displayName, code: id.toUpperCase(), type, layer, health: 'healthy', attributes });

const racks = [
  {
    ci: ci('rack-1', 'DMM-DH01-A-01', 'dc', 'rack', { row: 'A', position: 1 }),
    units: 42,
    occupiedUnits: 3,
    devices: [
      { ci: ci('srv-1', 'srv-dmm-01', 'hardware', 'host'), startUnit: 1, heightUnits: 2, face: 'front' },
      { ci: ci('tor-1', 'tor-dmm-01', 'network_security', 'network_device'), startUnit: 42, heightUnits: 1, face: 'front' },
    ],
    powerFeeds: [{ ci: ci('pdu-a', 'PDU-A', 'dc', 'power_feed'), ratedWatts: 7360, currentWatts: 2800 }],
    row: { id: 'row-a', displayName: 'A' },
    room: { id: 'room-1', displayName: 'DMM-DH01', attributes: {} },
  },
  {
    ci: ci('rack-2', 'DMM-DH01-A-02', 'dc', 'rack', { row: 'A', position: 2 }),
    units: 42,
    occupiedUnits: 0,
    devices: [],
    powerFeeds: [],
    row: { id: 'row-a', displayName: 'A' },
    room: { id: 'room-1', displayName: 'DMM-DH01', attributes: {} },
  },
];

const impact = {
  root: ci('db-1', 'ledger-db', 'databases', 'database'),
  durationMs: 12,
  nodes: [
    { ci: ci('app-1', 'ledger-app', 'applications', 'application'), depth: 1, predicted: 'degraded', path: ['db-1', 'app-1'] },
    { ci: ci('srv-1', 'srv-dmm-01', 'hardware', 'host'), depth: 1, predicted: 'down', path: ['db-1', 'srv-1'] },
  ],
  services: [],
};

const host = ci('srv-1', 'srv-dmm-01', 'hardware', 'host');
const hypervisor = ci('hv-1', 'esxi-01', 'virtualization', 'hypervisor');
const vm = ci('vm-1', 'vm-ledger-01', 'virtualization', 'vm');
const os = ci('os-1', 'RHEL 9', 'os', 'operating_system');
const ip = ci('ip-1', '10.20.0.11', 'network_security', 'ip_address');
const payments = ci('svc-1', 'Payments', 'applications', 'business_service');
const edge = (id: string, type: string, from: ReturnType<typeof ci>, to: ReturnType<typeof ci>) => ({ node: { id, type, from, to } });
const drills: Record<string, unknown> = {
  'srv-1': {
    ...host,
    components: [{ id: 'cpu-0', kind: 'cpu', slot: 'CPU0', model: 'Xeon Gold 6338', manufacturer: 'Intel', capacityBytes: null }],
    vulnerabilities: [{ cveId: 'CVE-2024-6387', cvss: 8.1, severity: 'high', exploited: true, internetFacing: false, fixedIn: '9.8p1' }],
    relationships: { totalCount: 3, edges: [edge('r1', 'runs_on', hypervisor, host), edge('r2', 'installed_on', os, host), edge('r3', 'uses_ip', host, ip)] },
  },
  'hv-1': {
    ...hypervisor,
    components: [],
    vulnerabilities: [],
    relationships: { totalCount: 2, edges: [edge('r1', 'runs_on', hypervisor, host), edge('r4', 'runs_on', vm, hypervisor)] },
  },
};

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  if (body.query.includes('query Racks(')) return { data: { racks } };
  if (body.query.includes('query TwinDrill(')) return { data: { ci: drills[String(body.variables?.['id'])] ?? null } };
  // The drill-down walks up from the drilled CI for the services it supports.
  if (body.query.includes('query Impact(') && body.variables?.['direction'] === 'upstream') {
    return { data: { impact: { root: host, durationMs: 3, nodes: [], services: [{ service: payments, tier: 1, predicted: 'down', path: ['srv-1', 'vm-1', 'app-1', 'svc-1'], usersAffected: null, slaBudgetRemainingMinutes: null, revenueAtRiskPerHour: null, recovery: null }] } } };
  }
  if (body.query.includes('query Impact(')) return { data: { impact } };
  if (body.query.includes('query Search(')) return { data: { search: [] } };
  return { errors: [{ message: 'unexpected operation' }] };
}

beforeEach(() => {
  sceneProps.length = 0;
  replace.mockReset();
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

describe.each(LOCALES)('TwinView in %s', (locale) => {
  it('builds the facility, selects a rack and lists its devices', async () => {
    search = '';
    render(
      <Providers locale={locale}>
        <TwinView locale={locale} />
      </Providers>,
    );
    const probe = await screen.findByTestId('scene-probe');
    expect(probe.getAttribute('data-racks')).toBe('2');
    expect(probe.getAttribute('data-nodes')).toBe('0');
    expect(screen.getByText(translate(locale, 'twin.panel.none'))).toBeTruthy();
    const kpis = screen.getAllByText(new Intl.NumberFormat(locale).format(2));
    expect(kpis.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('probe-rack-rack-1'));
    const panel = screen.getByRole('complementary');
    // The rack's name heads the panel and starts the breadcrumb.
    expect(within(panel).getAllByText('DMM-DH01-A-01').length).toBeGreaterThan(0);
    const devices = within(panel).getByRole('list', { name: translate(locale, 'twin.rack.devices') });
    const items = within(devices).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Top of the rack first.
    expect(items[0]?.textContent).toContain('tor-dmm-01');
    expect(within(panel).getByText(translate(locale, 'twin.rack.load', { load: new Intl.NumberFormat(locale).format(38) }))).toBeTruthy();
    expect(within(panel).getByRole('link', { name: translate(locale, 'twin.panel.openCi') }).getAttribute('href')).toContain('/cmdb/rack-1');
  });

  it('drills from a rack to a device and on through its relationships, and back by the breadcrumb', async () => {
    search = '';
    render(
      <Providers locale={locale}>
        <TwinView locale={locale} />
      </Providers>,
    );
    fireEvent.click(await screen.findByTestId('probe-rack-rack-1'));
    const panel = screen.getByRole('complementary');
    fireEvent.click(within(panel).getByRole('button', { name: translate(locale, 'twin.drill.into', { name: 'srv-dmm-01' }) }));
    // The device is selected in the scene as well.
    expect(sceneProps[sceneProps.length - 1]?.selected).toEqual({ kind: 'device', id: 'srv-1' });

    const level = await within(panel).findByTestId('twin-drill-level');
    for (const key of ['components', 'compute', 'os', 'network', 'services', 'security'] as const) {
      expect(within(level).getByRole('region', { name: translate(locale, `twin.drill.section.${key}`) })).toBeTruthy();
    }
    expect(within(level).getByText('Xeon Gold 6338')).toBeTruthy();
    expect(within(level).getByText('CVE-2024-6387')).toBeTruthy();
    expect(within(level).getByText(translate(locale, 'twin.drill.exploited'))).toBeTruthy();
    // The service is reached through the VM and its application: three hops up.
    const services = within(level).getByRole('region', { name: translate(locale, 'twin.drill.section.services') });
    expect(await within(services).findByText('Payments')).toBeTruthy();
    expect(within(services).getByText(new RegExp(translate(locale, 'twin.drill.viaGraph', { hops: new Intl.NumberFormat(locale).format(3) })))).toBeTruthy();

    // One level further: the hypervisor, with the VM it runs.
    const compute = within(level).getByRole('region', { name: translate(locale, 'twin.drill.section.compute') });
    fireEvent.click(within(compute).getByRole('button', { name: translate(locale, 'twin.drill.into', { name: 'esxi-01' }) }));
    const trail = within(panel).getByRole('navigation', { name: translate(locale, 'twin.drill.trail') });
    expect(within(trail).getAllByRole('listitem')).toHaveLength(3);
    expect(await within(panel).findByRole('button', { name: translate(locale, 'twin.drill.into', { name: 'vm-ledger-01' }) })).toBeTruthy();

    // Back to the rack.
    fireEvent.click(within(trail).getByRole('button', { name: 'DMM-DH01-A-01' }));
    expect(within(panel).getByRole('list', { name: translate(locale, 'twin.rack.devices') })).toBeTruthy();
    expect(sceneProps[sceneProps.length - 1]?.selected).toEqual({ kind: 'rack', id: 'rack-1' });
  });

  it('opens a rack from the picker, without the scene', async () => {
    search = '';
    render(
      <Providers locale={locale}>
        <TwinView locale={locale} />
      </Providers>,
    );
    await screen.findByTestId('scene-probe');
    fireEvent.change(screen.getByLabelText(translate(locale, 'twin.drill.pickRack')), { target: { value: 'rack-1' } });
    const panel = screen.getByRole('complementary');
    expect(within(panel).getByRole('list', { name: translate(locale, 'twin.rack.devices') })).toBeTruthy();
  });

  it('lays the focus CI dependency graph on the layer planes and selects a node', async () => {
    search = 'ci=db-1';
    render(
      <Providers locale={locale}>
        <TwinView locale={locale} />
      </Providers>,
    );
    const probe = await screen.findByTestId('scene-probe');
    await screen.findByTestId('probe-node-db-1');
    expect(probe.getAttribute('data-nodes')).toBe('3');
    expect(probe.getAttribute('data-planes')).toBe('3');
    const planes = screen.getByRole('list', { name: translate(locale, 'twin.planes.label') });
    expect(within(planes).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      translate(locale, 'layer.applications') + ' · ' + new Intl.NumberFormat(locale).format(1),
      translate(locale, 'layer.databases') + ' · ' + new Intl.NumberFormat(locale).format(1),
      translate(locale, 'layer.hardware') + ' · ' + new Intl.NumberFormat(locale).format(1),
    ]);
    const last = sceneProps[sceneProps.length - 1];
    const app = last?.graph?.nodes.find((n) => n.id === 'app-1');
    const srv = last?.graph?.nodes.find((n) => n.id === 'srv-1');
    expect(app !== undefined && srv !== undefined && app.position[1] > srv.position[1]).toBe(true);

    fireEvent.click(screen.getByTestId('probe-node-app-1'));
    const panel = screen.getByRole('complementary');
    expect(within(panel).getByText('ledger-app')).toBeTruthy();
    expect(within(panel).getByText(translate(locale, 'impact.predicted.degraded'))).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: translate(locale, 'twin.panel.focusHere') }));
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('/twin?ci=app-1'));
  });
});
