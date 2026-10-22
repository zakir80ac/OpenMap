// T-103 REQ-UI-011 — DCIM in en and ar: racks group into rooms with power and occupancy, the heat map selects a
// rack, the elevation draws every mounted device at its unit, and the power table lists the PDUs feeding the rack.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';
import { DcimView, groupRooms, heatAccent, percentOf, rackPower } from './DcimView';

const authValue = (): AuthValue =>
  ({ status: 'signed-in', user: { subject: 's1', username: 'an', displayName: 'Analyst', email: 'a@bank.local', tenant: 'default', roles: ['openmap-analyst'] }, reason: undefined, reasonDetail: undefined, can: () => true, getAccessToken: () => 'tok', signIn: async () => undefined, completeSignIn: async () => '/', signOut: async () => undefined }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useAuth: () => authValue(), useCan: () => authValue().can }));

const ci = (id: string, name: string, type: string, layer = 'hardware') => ({ id, name, displayName: name, type, layer, health: 'healthy' });
const racks = [
  {
    ci: { ...ci('r1', 'RYD-DH01-A-01', 'rack', 'dc'), attributes: { heightU: 42 } },
    units: 42,
    occupiedUnits: 3,
    devices: [
      { ci: ci('h1', 'esx-01', 'host'), startUnit: 1, heightUnits: 2, face: 'front' },
      { ci: ci('n1', 'leaf-01', 'network_device', 'network_security'), startUnit: 40, heightUnits: 1, face: 'front' },
    ],
    powerFeeds: [{ ci: ci('p1', 'pdu-a', 'pdu', 'dc'), ratedWatts: 7360, currentWatts: 3700 }],
    row: { id: 'row1', displayName: 'RYD-DH01-A' },
    room: { id: 'room1', displayName: 'RYD-DH01', attributes: { designKw: 2400 } },
  },
  { ci: { ...ci('r2', 'RYD-DH01-A-02', 'rack', 'dc'), attributes: {} }, units: 42, occupiedUnits: 0, devices: [], powerFeeds: [], row: { id: 'row1', displayName: 'RYD-DH01-A' }, room: { id: 'room1', displayName: 'RYD-DH01', attributes: { designKw: 2400 } } },
  { ci: { ...ci('r3', 'JED-DH02-B-01', 'rack', 'dc'), attributes: {} }, units: 42, occupiedUnits: 42, devices: [], powerFeeds: [{ ci: ci('p2', 'pdu-b', 'pdu', 'dc'), ratedWatts: 7360, currentWatts: 7000 }], row: null, room: { id: 'room2', displayName: 'JED-DH02', attributes: {} } },
];

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: { racks } }), { status: 200, headers: { 'content-type': 'application/json' } }))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DcimView helpers', () => {
  it('groups racks by room with summed power and occupancy', () => {
    const rooms = groupRooms(racks as never, 'unplaced');
    expect(rooms.map((r) => [r.name, r.racks.length, r.currentWatts, r.designKw])).toEqual([
      ['JED-DH02', 1, 7000, null],
      ['RYD-DH01', 2, 3700, 2400],
    ]);
    expect(rackPower(racks[0] as never)).toEqual({ ratedWatts: 7360, currentWatts: 3700 });
    expect(percentOf(21, 42)).toBe(50);
    expect(percentOf(1, 0)).toBe(0);
    expect(heatAccent(95, 0)).not.toBe(heatAccent(10, 0));
    expect(heatAccent(0, 100)).toBe(heatAccent(100, 0));
  });
});

describe.each(LOCALES)('DcimView (%s)', (locale) => {
  it('shows rooms, the heat map, and the selected rack elevation with its devices and power', async () => {
    render(
      <Providers locale={locale}>
        <DcimView locale={locale} />
      </Providers>,
    );
    const heatmap = await screen.findByRole('listbox', { name: translate(locale, 'dcim.heatmap.title') });
    // First room alphabetically is JED-DH02 with one rack; switch to RYD-DH01.
    expect(within(heatmap).getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'RYD-DH01' }));
    const ryd = await screen.findByRole('listbox', { name: translate(locale, 'dcim.heatmap.title') });
    expect(within(ryd).getAllByRole('option')).toHaveLength(2);
    fireEvent.click(within(ryd).getByRole('option', { name: /RYD-DH01-A-01$/ }));
    const elevation = await screen.findByRole('img', { name: translate(locale, 'dcim.elevation.aria', { name: 'RYD-DH01-A-01', units: '42' }) });
    expect(elevation.querySelectorAll('rect').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('esx-01', { selector: 'a' })).toBeTruthy();
    expect(screen.getByText('U1–2')).toBeTruthy();
    expect(screen.getByText('pdu-a')).toBeTruthy();
  });
});
