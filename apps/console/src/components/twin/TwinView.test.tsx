// T-120 REQ-UI-029 — TwinView builds the facility from the racks query, lays a focus CI's impact graph on the layer
// planes, hands the models to the scene, and shows the selected rack's devices and the selected node's CI, in en
// and ar. The WebGL scene is replaced by a probe that reports what it received, since jsdom has no GPU.
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

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  if (body.query.includes('query Racks(')) return { data: { racks } };
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
    expect(within(panel).getByText('DMM-DH01-A-01')).toBeTruthy();
    const devices = within(panel).getByRole('list', { name: translate(locale, 'twin.rack.devices') });
    const items = within(devices).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Top of the rack first.
    expect(items[0]?.textContent).toContain('tor-dmm-01');
    expect(within(panel).getByText(translate(locale, 'twin.rack.load', { load: new Intl.NumberFormat(locale).format(38) }))).toBeTruthy();
    expect(within(panel).getByRole('link', { name: translate(locale, 'twin.panel.openCi') }).getAttribute('href')).toContain('/cmdb/rack-1');
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
