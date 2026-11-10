// T-557 REQ-IPAM-004 (ADR-063) — the IPAM Switch ports tab over stubbed GraphQL, in en and ar: a switch found by search
// lists its ports with state, unused mark, speed, VLAN, neighbour and learned MAC (with IP and owner); choosing a port
// shows its history; a MAC typed in Cisco notation is looked up in canonical form and its sightings are listed; text
// that is not a MAC cannot be submitted.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { MacLookup, PortHistory, SwitchPorts } from '@/lib/switch-ports-queries';
import { SwitchPortsView, changeKey, macLabel, stateKey } from './SwitchPortsView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/ipam',
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => children }));

const ci = (id: string, name: string, type = 'network_device') => ({ id, name, displayName: name, type });
const SERVER = ci('srv-1', 'srv-01', 'host');
const ports: SwitchPorts = {
  device: ci('tor-1', 'tor-01'),
  summary: { ports: 3, up: 1, down: 2, adminDown: 0, unknown: 0, unused: 1, learnedMacs: 3 },
  ports: [
    {
      port: ci('e1', 'tor-01 Ethernet1', 'interface'),
      name: 'Ethernet1',
      alias: 'srv-01 eno1',
      state: 'up',
      speedMbps: 10_000,
      mtu: 9216,
      vlan: 204,
      learnedMacs: [{ mac: '00:50:56:9a:01:02', ip: '10.77.4.21', owner: SERVER }],
      learnedMacCount: 3,
      neighbour: { ci: SERVER, port: 'eno1', protocol: 'lldp' },
      lastChange: null,
      daysNotUp: null,
      unused: false,
    },
    {
      port: ci('e2', 'tor-01 Ethernet2', 'interface'),
      name: 'Ethernet2',
      alias: null,
      state: 'down',
      speedMbps: 10_000,
      mtu: 9216,
      vlan: null,
      learnedMacs: [],
      learnedMacCount: 0,
      neighbour: null,
      lastChange: '2026-09-26T10:00:00.000Z',
      daysNotUp: 45,
      unused: true,
    },
    {
      port: ci('e3', 'tor-01 Ethernet3', 'interface'),
      name: 'Ethernet3',
      alias: null,
      state: 'down',
      speedMbps: null,
      mtu: null,
      vlan: null,
      learnedMacs: [],
      learnedMacCount: 0,
      neighbour: null,
      lastChange: null,
      daysNotUp: 2,
      unused: false,
    },
  ],
};
const history: PortHistory = {
  port: ci('e2', 'tor-01 Ethernet2', 'interface'),
  days: 90,
  versions: 3,
  changes: [
    { at: '2026-09-26T10:00:00.000Z', key: 'state', from: 'up', to: 'down' },
    { at: '2026-09-26T10:00:00.000Z', key: 'alias', from: 'old-srv-07', to: null },
  ],
};
const lookup: MacLookup = {
  mac: '00:50:56:9a:01:02',
  sightings: [
    {
      kind: 'learned_on_port',
      ci: ci('tor-1', 'tor-01'),
      port: 'Ethernet1',
      ip: null,
      seenAt: '2026-11-10T08:00:00.000Z',
    },
    {
      kind: 'arp',
      ci: ci('ip-1', '10.77.4.21', 'ip_address'),
      port: null,
      ip: '10.77.4.21',
      seenAt: '2026-11-10T08:00:00.000Z',
    },
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
      const data = body.query.includes('switchPorts(')
        ? { switchPorts: ports }
        : body.query.includes('portHistory(')
          ? { portHistory: history }
          : body.query.includes('macLookup(')
            ? { macLookup: lookup }
            : {
                search: [
                  {
                    ci: {
                      ...ci('tor-1', 'tor-01'),
                      code: 'SW1',
                      layer: 'network_security',
                      health: 'healthy',
                    },
                    score: 1,
                    highlight: null,
                  },
                  {
                    ci: {
                      ...ci('vlan-1', 'PROD-4', 'vlan'),
                      code: 'V1',
                      layer: 'network_security',
                      health: 'healthy',
                    },
                    score: 1,
                    highlight: null,
                  },
                ],
              };
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

describe('switch port helpers', () => {
  it('maps states and change keys to their labels and words a learned MAC with what is known about it', () => {
    const t = (key: string, params?: Record<string, string | number>) =>
      translate('en', key as Parameters<typeof translate>[1], params);
    expect(stateKey('admin_down')).toBe('ipam.ports.state.admin_down');
    expect(changeKey('speedMbps')).toBe('ipam.ports.history.key.speedMbps');
    expect(changeKey('something')).toBe('ipam.ports.history.key.other');
    expect(macLabel(t, { mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.0.1', owner: SERVER })).toBe(
      'aa:bb:cc:dd:ee:ff · srv-01 · 10.0.0.1',
    );
    expect(macLabel(t, { mac: 'aa:bb:cc:dd:ee:ff', ip: null, owner: null })).toBe('aa:bb:cc:dd:ee:ff');
  });
});

describe.each(LOCALES)('SwitchPortsView (%s)', (locale) => {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key as Parameters<typeof translate>[1], params);

  it("lists a switch's ports and opens a port's history", async () => {
    render(
      <Providers locale={locale}>
        <SwitchPortsView locale={locale} />
      </Providers>,
    );
    fireEvent.change(screen.getByLabelText(t('ipam.ports.search')), { target: { value: 'tor' } });
    const device = screen.getByLabelText(t('ipam.ports.device'));
    await waitFor(() => {
      expect(within(device).getByRole('option', { name: 'tor-01' })).toBeTruthy();
    });
    // Only switches are offered, not the VLAN the search also matched.
    expect(within(device).queryByRole('option', { name: 'PROD-4' })).toBeNull();
    fireEvent.change(device, { target: { value: 'tor-1' } });
    const table = await screen.findByRole('table', {
      name: t('ipam.ports.table.title', { device: 'tor-01' }),
    });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['up', 'down', 'down']);
    expect(within(rows[0] as HTMLElement).getByText('00:50:56:9a:01:02 · srv-01 · 10.77.4.21')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(t('ipam.ports.moreMacs', { count: '2' }))).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement).getByText(t('ipam.ports.neighbourPort', { ci: 'srv-01', port: 'eno1' })),
    ).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(t('ipam.ports.unused', { days: '45' }))).toBeTruthy();
    expect(within(rows[2] as HTMLElement).queryByText(t('ipam.ports.unused', { days: '2' }))).toBeNull();
    expect(sent.find((s) => s.query.includes('switchPorts('))?.variables).toEqual({ deviceId: 'tor-1' });

    fireEvent.click(
      within(rows[1] as HTMLElement).getByRole('button', {
        name: t('ipam.ports.history.open', { port: 'Ethernet2' }),
      }),
    );
    const card = await screen.findByTestId('port-history');
    await waitFor(() => {
      expect(within(card).getByText(t('ipam.ports.history.key.state'))).toBeTruthy();
    });
    expect(within(card).getByText(t('ipam.ports.state.down'))).toBeTruthy();
    expect(within(card).getByText('old-srv-07')).toBeTruthy();
    expect(sent.find((s) => s.query.includes('portHistory('))?.variables).toEqual({ portId: 'e2' });
  });

  it('looks a MAC up in canonical form and refuses text that is not a MAC', async () => {
    render(
      <Providers locale={locale}>
        <SwitchPortsView locale={locale} />
      </Providers>,
    );
    const form = screen.getByRole('form', { name: t('ipam.ports.mac.title') });
    const input = within(form).getByLabelText(t('ipam.ports.mac.label'));
    const find = within(form).getByRole('button', { name: t('ipam.ports.mac.find') });
    fireEvent.change(input, { target: { value: 'not a mac' } });
    expect((find as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByText(t('ipam.ports.mac.invalid'))).toBeTruthy();
    fireEvent.change(input, { target: { value: '0050.569A.0102' } });
    fireEvent.click(find);
    const results = await screen.findByRole('list', {
      name: t('ipam.ports.mac.results', { mac: '00:50:56:9a:01:02' }),
    });
    expect(within(results).getByText(t('ipam.ports.mac.kind.learned_on_port'))).toBeTruthy();
    expect(within(results).getByText('Ethernet1')).toBeTruthy();
    expect(within(results).getAllByText('10.77.4.21').length).toBeGreaterThan(0);
    expect(sent.find((s) => s.query.includes('macLookup('))?.variables).toEqual({ mac: '00:50:56:9a:01:02' });
  });
});
