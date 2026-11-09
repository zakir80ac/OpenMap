// T-522 REQ-DCIM-001 (ADR-056) — the DCIM Cabling tab over stubbed GraphQL, in en and ar: the totals, a patch panel
// with its positions (front and rear cables, a circuit), the cables with both ends and the circuits; choosing a cable
// end shows the trace through the panel to the far end; an operator connects a cable between a device port found by
// search and a panel position (with its side), and mounts a panel in a rack.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { Rack } from '@/lib/estate-queries';
import { CablingView } from './CablingView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/en/dcim' }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<object>()), useCan: () => () => true }));

const SWITCH = { id: 'sw-1', name: 'tor-01', type: 'network_device' };
const SERVER = { id: 'srv-1', name: 'srv-01', type: 'host' };
const PANEL = { id: 'pp-1', name: 'R01 PP-01', type: 'patch_panel' };
const patch1 = { ci: { id: 'c-1' }, label: 'C-0001', kind: 'patch', media: 'cat6a', lengthM: 2, colour: 'blue', a: { ci: SWITCH, port: 'Gi1/0/1', side: null }, b: { ci: PANEL, port: '1', side: 'front' } };
const patch2 = { ci: { id: 'c-2' }, label: 'C-0002', kind: 'cross_connect', media: 'os2', lengthM: null, colour: null, a: { ci: PANEL, port: '1', side: 'rear' }, b: { ci: SERVER, port: 'eth0', side: null } };
const cabling = {
  summary: { patchPanels: 1, positions: 4, positionsUsed: 2, cables: 2, crossConnects: 1, circuits: 1 },
  patchPanels: [
    {
      ci: PANEL, rack: { id: 'rack-1', name: 'R01' }, name: 'PP-01', ports: 4, media: 'cat6a', connector: 'rj45', uPosition: 40, used: 2,
      positions: [
        { position: 1, front: { ci: { id: 'c-1' }, label: 'C-0001' }, rear: { ci: { id: 'c-2' }, label: 'C-0002' }, circuit: null },
        { position: 2, front: null, rear: null, circuit: { ci: { id: 'k-1' }, circuitId: 'MPLS-77' } },
        { position: 3, front: null, rear: null, circuit: null },
        { position: 4, front: null, rear: null, circuit: null },
      ],
    },
  ],
  cables: [patch1, patch2],
  circuits: [{ ci: { id: 'k-1' }, provider: 'Telco', circuitId: 'MPLS-77', kind: 'mpls', status: 'active', bandwidthMbps: 1000, aEnd: { ci: PANEL, port: '2', side: 'rear' }, zEnd: null, zEndDescription: 'Provider POP' }],
};
const trace = {
  complete: true,
  looped: false,
  hops: [
    { viaKind: 'cable', via: { id: 'c-1', name: 'C-0001' }, from: patch1.a, to: patch1.b },
    { viaKind: 'cable', via: { id: 'c-2', name: 'C-0002' }, from: patch2.a, to: patch2.b },
  ],
};
const racks = [{ ci: { id: 'rack-1', name: 'R01' } }] as unknown as Rack[];
const sent: Array<{ query: string; variables: Record<string, unknown> | undefined }> = [];

beforeEach(() => {
  sent.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables?: Record<string, unknown> };
      sent.push({ query: body.query, variables: body.variables });
      const data = body.query.includes('connectCable')
        ? { connectCable: patch1 }
        : body.query.includes('upsertPatchPanel')
          ? { upsertPatchPanel: cabling.patchPanels[0] }
          : body.query.includes('cableTrace')
            ? { cableTrace: trace }
            : body.query.includes('search(')
              ? { search: [{ ci: { ...SWITCH, displayName: SWITCH.name, code: 'SW1', layer: 'network_security', health: 'healthy' }, score: 1, highlight: null }] }
              : { cabling };
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('CablingView in %s', (locale) => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string => translate(locale, key, params);

  it('shows panels, cables and circuits, and traces a path from a cable end', async () => {
    render(
      <Providers locale={locale}>
        <CablingView racks={racks} />
      </Providers>,
    );
    const panels = await screen.findByRole('table', { name: t('dcim.cabling.panels.title') });
    expect(within(panels).getByText('PP-01')).toBeTruthy();
    expect(within(panels).getByText('R01')).toBeTruthy();
    const grid = screen.getByRole('list', { name: t('dcim.cabling.positions', { panel: 'R01 PP-01' }) });
    expect(within(grid).getAllByRole('button')).toHaveLength(4);
    expect(within(grid).getByRole('button', { name: new RegExp(t('dcim.cabling.circuitOn', { circuit: 'MPLS-77' })) })).toBeTruthy();

    const cables = screen.getByRole('table', { name: t('dcim.cabling.cables.title') });
    expect(within(cables).getByText(t('dcim.cabling.kindName.cross_connect'))).toBeTruthy();
    const circuits = screen.getByRole('table', { name: t('dcim.cabling.circuits.title') });
    expect(within(circuits).getByText('MPLS-77')).toBeTruthy();
    expect(within(circuits).getByText('Provider POP')).toBeTruthy();

    fireEvent.click(within(cables).getByRole('button', { name: t('dcim.cabling.trace.from', { end: t('dcim.cabling.endPort', { ci: 'tor-01', port: 'Gi1/0/1' }) }) }));
    const path = await screen.findByRole('list', { name: t('dcim.cabling.trace.title') });
    expect(within(path).getAllByRole('listitem')).toHaveLength(2);
    expect(within(path).getByText(t('dcim.cabling.endPort', { ci: 'srv-01', port: 'eth0' }))).toBeTruthy();
    expect(screen.getByText(t('dcim.cabling.trace.complete'))).toBeTruthy();
    expect(sent.find((s) => s.query.includes('cableTrace'))?.variables).toEqual({ endpoint: { ciId: 'sw-1', port: 'Gi1/0/1', side: null } });
  });

  it('connects a cable from a searched port to a panel position, and mounts a panel', async () => {
    render(
      <Providers locale={locale}>
        <CablingView racks={racks} />
      </Providers>,
    );
    const form = await screen.findByRole('form', { name: t('dcim.cabling.cableForm') });
    fireEvent.change(within(form).getByRole('textbox', { name: t('dcim.cabling.label') }), { target: { value: 'C-0003' } });
    const endA = within(form).getByRole('group', { name: t('dcim.cabling.endA') });
    fireEvent.change(within(endA).getByRole('searchbox', { name: t('dcim.cabling.endpoint.search') }), { target: { value: 'tor' } });
    await waitFor(() => {
      expect(within(endA).getByRole('option', { name: t('dcim.cabling.endpoint.option', { name: 'tor-01', type: 'network_device' }) })).toBeTruthy();
    });
    fireEvent.change(within(endA).getByRole('combobox', { name: t('dcim.cabling.endpoint.ci') }), { target: { value: 'sw-1' } });
    fireEvent.change(within(endA).getByRole('textbox', { name: t('dcim.cabling.endpoint.port') }), { target: { value: 'Gi1/0/2' } });
    const endB = within(form).getByRole('group', { name: t('dcim.cabling.endB') });
    fireEvent.change(within(endB).getByRole('combobox', { name: t('dcim.cabling.endpoint.ci') }), { target: { value: 'pp-1' } });
    fireEvent.change(within(endB).getByRole('textbox', { name: t('dcim.cabling.endpoint.position') }), { target: { value: '3' } });
    fireEvent.change(within(endB).getByRole('combobox', { name: t('dcim.cabling.endpoint.side') }), { target: { value: 'rear' } });
    fireEvent.click(within(form).getByRole('button', { name: t('dcim.cabling.cableForm') }));
    await waitFor(() => {
      expect(sent.find((s) => s.query.includes('connectCable'))?.variables).toEqual({
        input: { label: 'C-0003', kind: 'patch', media: 'cat6a', lengthM: null, colour: null, a: { ciId: 'sw-1', port: 'Gi1/0/2', side: null }, b: { ciId: 'pp-1', port: '3', side: 'rear' } },
      });
    });

    const panelForm = screen.getByRole('form', { name: t('dcim.cabling.panelForm') });
    fireEvent.change(within(panelForm).getByRole('combobox', { name: t('dcim.cabling.rack') }), { target: { value: 'rack-1' } });
    fireEvent.change(within(panelForm).getByRole('textbox', { name: t('dcim.cabling.panelName') }), { target: { value: 'PP-02' } });
    fireEvent.change(within(panelForm).getByRole('spinbutton', { name: t('dcim.cabling.ports') }), { target: { value: '24' } });
    fireEvent.change(within(panelForm).getByRole('spinbutton', { name: t('dcim.cabling.unit') }), { target: { value: '39' } });
    fireEvent.click(within(panelForm).getByRole('button', { name: t('dcim.cabling.panelForm') }));
    await waitFor(() => {
      expect(sent.find((s) => s.query.includes('upsertPatchPanel'))?.variables).toEqual({ input: { rackId: 'rack-1', name: 'PP-02', ports: 24, media: 'cat6a', connector: 'rj45', uPosition: 39 } });
    });
  });
});
