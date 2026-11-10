// T-530 REQ-DCIM-004 (ADR-058) — the DCIM Power view over stubbed GraphQL, in en and ar: the room's totals, the
// redundancy findings with their detail (the failover load against the survivor's rating), the chain by kind (UPS,
// circuits, PDUs) with load against rating, and a PDU's outlets where an operator plugs in a device found by search.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { Rack } from '@/lib/estate-queries';
import { PowerView } from './PowerView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/dcim',
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCan: () => () => true,
}));

const ci = (id: string, type: string) => ({ id, name: id, type });
const chain = {
  summary: { ups: 2, circuits: 2, pdus: 2, devices: 3, redundantDevices: 2, findings: 2 },
  sources: [
    {
      ci: ci('UPS-A', 'ups'),
      kind: 'ups',
      feed: 'A',
      ratedWatts: 100_000,
      loadWatts: 40_000,
      outlets: null,
      outletsUsed: 0,
      runtimeMinutes: 4,
      fedBy: [],
      rack: null,
    },
    {
      ci: ci('CKT-A', 'power_circuit'),
      kind: 'power_circuit',
      feed: 'A',
      ratedWatts: 43_648,
      loadWatts: 2_500,
      outlets: null,
      outletsUsed: 0,
      runtimeMinutes: null,
      fedBy: [ci('UPS-A', 'ups')],
      rack: null,
    },
    {
      ci: ci('R01 PDU-A', 'pdu'),
      kind: 'pdu',
      feed: 'A',
      ratedWatts: 3_680,
      loadWatts: 2_500,
      outlets: 24,
      outletsUsed: 2,
      runtimeMinutes: null,
      fedBy: [ci('CKT-A', 'power_circuit')],
      rack: ci('R01', 'rack'),
    },
    {
      ci: ci('R01 PDU-B', 'pdu'),
      kind: 'pdu',
      feed: 'B',
      ratedWatts: 7_360,
      loadWatts: 2_000,
      outlets: 24,
      outletsUsed: 1,
      runtimeMinutes: null,
      fedBy: [],
      rack: ci('R01', 'rack'),
    },
  ],
  findings: [
    {
      kind: 'pdu_failover_overload',
      ci: ci('R01 PDU-A', 'pdu'),
      partner: ci('R01 PDU-B', 'pdu'),
      load: 4_500,
      capacity: 3_680,
    },
    { kind: 'single_corded', ci: ci('srv-single', 'host'), partner: null, load: null, capacity: null },
  ],
};
const connections = [
  { id: 'rel-1', device: ci('srv-dual', 'host'), pdu: ci('R01 PDU-A', 'pdu'), feed: 'A', psu: 1, outlet: 1 },
];
const racks = [
  { ci: { id: 'R01' }, room: { id: 'dh1', displayName: 'DH01', attributes: {} } },
] as unknown as Rack[];
const sent: Array<{ query: string; variables: Record<string, unknown> | undefined }> = [];

beforeEach(() => {
  sent.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { query: string; variables?: Record<string, unknown> };
      sent.push({ query: body.query, variables: body.variables });
      const data = body.query.includes('connectPower')
        ? { connectPower: connections[0] }
        : body.query.includes('pduConnections')
          ? { pduConnections: connections }
          : body.query.includes('search(')
            ? {
                search: [
                  {
                    ci: {
                      id: 'srv-new',
                      name: 'srv-new',
                      displayName: 'srv-new',
                      code: 'S1',
                      type: 'host',
                      layer: 'hardware',
                      health: 'healthy',
                    },
                    score: 1,
                    highlight: null,
                  },
                ],
              }
            : { powerChain: chain };
      return Promise.resolve(
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('PowerView in %s', (locale) => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string =>
    translate(locale, key, params);

  it('shows findings and the chain, and plugs a device into a PDU outlet', async () => {
    render(
      <Providers locale={locale}>
        <PowerView racks={racks} />
      </Providers>,
    );
    const findings = await screen.findByRole('table', { name: t('dcim.power.findings.title') });
    expect(within(findings).getByText(t('dcim.power.findingKind.pdu_failover_overload'))).toBeTruthy();
    expect(within(findings).getByText(t('dcim.power.detail.single_corded'))).toBeTruthy();
    expect(within(findings).getByText(new RegExp('R01 PDU-B'))).toBeTruthy();
    expect(screen.getByRole('table', { name: t('dcim.power.kind.ups') })).toBeTruthy();
    expect(screen.getByRole('table', { name: t('dcim.power.kind.power_circuit') })).toBeTruthy();
    const pdus = screen.getByRole('table', { name: t('dcim.power.kind.pdu') });

    fireEvent.click(
      within(pdus).getByRole('button', { name: t('dcim.power.showOutlets', { pdu: 'R01 PDU-A' }) }),
    );
    const outlets = await screen.findByRole('table', {
      name: t('dcim.power.outletsTitle', { pdu: 'R01 PDU-A' }),
    });
    await waitFor(() => {
      expect(within(outlets).getByText('srv-dual')).toBeTruthy();
    });
    const form = screen.getByRole('form', { name: t('dcim.power.plug') });
    fireEvent.change(within(form).getByRole('searchbox', { name: t('dcim.power.findDevice') }), {
      target: { value: 'srv' },
    });
    await waitFor(() => {
      expect(
        within(form).getByRole('option', {
          name: t('dcim.cabling.endpoint.option', { name: 'srv-new', type: 'host' }),
        }),
      ).toBeTruthy();
    });
    fireEvent.change(within(form).getByRole('combobox', { name: t('dcim.power.device') }), {
      target: { value: 'srv-new' },
    });
    fireEvent.change(within(form).getByRole('spinbutton', { name: t('dcim.power.outlet') }), {
      target: { value: '3' },
    });
    fireEvent.change(within(form).getByRole('spinbutton', { name: t('dcim.power.psu') }), {
      target: { value: '2' },
    });
    fireEvent.click(within(form).getByRole('button', { name: t('dcim.power.plug') }));
    await waitFor(() => {
      expect(sent.find((s) => s.query.includes('connectPower'))?.variables).toEqual({
        input: { deviceId: 'srv-new', pduId: 'R01 PDU-A', outlet: 3, psu: 2 },
      });
    });
  });
});
