// T-548 REQ-DCIM-007 (ADR-061) — the DCIM Capacity view over stubbed GraphQL, in en and ar: the room's four figures
// with their states, the totals, the trend's days to each line, the racks worst first with free units, largest block,
// power, ports and the fit count, and the what-fits form recomputing the fit when the spec changes.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { Rack } from '@/lib/estate-queries';
import type { RackCapacity, RoomCapacity } from '@/lib/capacity-queries';
import { CapacityView, fitSummary, sortRacks } from './CapacityView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/dcim',
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => children }));

const ci = (id: string, name: string, type = 'rack') => ({ id, name, displayName: name, type, layer: 'dc' });
const rackA: RackCapacity = {
  rack: ci('r1', 'DH01-A-01'),
  space: { units: 42, occupied: 30, free: 12, largestFreeBlock: 8, freeBlocks: [8, 4], percent: 71.4 },
  power: {
    designWatts: 8_000,
    loadWatts: 7_400,
    percent: 92.5,
    state: 'critical',
    measuredAt: '2026-11-09T18:00:00.000Z',
  },
  ports: { total: 48, used: 40, free: 8, percent: 83.3 },
  state: 'critical',
};
const rackB: RackCapacity = {
  rack: ci('r2', 'DH01-A-02'),
  space: { units: 42, occupied: 10, free: 32, largestFreeBlock: 32, freeBlocks: [32], percent: 23.8 },
  power: {
    designWatts: 8_000,
    loadWatts: 2_000,
    percent: 25,
    state: 'normal',
    measuredAt: '2026-11-09T18:00:00.000Z',
  },
  ports: { total: 48, used: 10, free: 38, percent: 20.8 },
  state: 'normal',
};
const rackC: RackCapacity = {
  rack: ci('r3', 'DH01-B-01'),
  space: { units: 42, occupied: 0, free: 42, largestFreeBlock: 42, freeBlocks: [42], percent: 0 },
  power: { designWatts: 0, loadWatts: 0, percent: null, state: 'unknown', measuredAt: null },
  ports: { total: 0, used: 0, free: 0, percent: null },
  state: 'unknown',
};
const room: RoomCapacity = {
  room: ci('dh1', 'DH01', 'room'),
  racks: [rackB, rackC, rackA],
  space: {
    units: 126,
    occupied: 40,
    free: 86,
    largestFreeBlock: 42,
    freeBlocks: [8, 4, 32, 42],
    percent: 31.7,
  },
  power: {
    designWatts: 16_000,
    loadWatts: 9_400,
    percent: 58.75,
    state: 'normal',
    measuredAt: '2026-11-09T18:00:00.000Z',
  },
  cooling: { capacityKw: 12, loadKw: 9.4, percent: 78.3, state: 'warning', units: 1 },
  ports: { total: 96, used: 50, free: 46, percent: 52.1 },
  trend: { days: 30, points: 12, slopeKwPerDay: 0.25, daysToWarning: 8, daysToCritical: 21 },
  state: 'critical',
};
const racks = [
  { ci: { id: 'r1' }, room: { id: 'dh1', displayName: 'DH01', attributes: {} } },
] as unknown as Rack[];
const sent: Array<Record<string, unknown> | undefined> = [];

beforeEach(() => {
  sent.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      sent.push((JSON.parse(String(init.body)) as { variables?: Record<string, unknown> }).variables);
      return Promise.resolve(
        new Response(JSON.stringify({ data: { roomCapacity: room } }), {
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

describe('capacity helpers', () => {
  it('sorts racks worst state first and counts how many devices of a spec the room takes', () => {
    expect(sortRacks(room.racks).map((r) => r.rack.name)).toEqual(['DH01-A-01', 'DH01-A-02', 'DH01-B-01']);
    const fit = fitSummary(room.racks, { heightU: 2, watts: 500, ports: 2 });
    // A: 4 + 2 blocks by space, 1 by power (600 W headroom), 4 by ports → 1; B: 16 by space, 12 by power, 19 by ports → 12;
    // C: 21 by space and no power or port constraint recorded → 21.
    expect(fit.perRack.get('r1')).toBe(1);
    expect(fit.perRack.get('r2')).toBe(12);
    expect(fit.perRack.get('r3')).toBe(21);
    expect(fit.devices).toBe(34);
    expect(fit.racks).toBe(3);
  });
});

describe.each(LOCALES)('CapacityView (%s)', (locale) => {
  it('shows the figures, totals, trend and racks and recomputes the fit when the spec changes', async () => {
    render(
      <Providers locale={locale}>
        <CapacityView locale={locale} racks={racks} />
      </Providers>,
    );
    const figures = await screen.findByRole('group', { name: translate(locale, 'dcim.capacity.figures') });
    expect(sent[0]).toEqual({ roomId: 'dh1' });
    expect(
      within(figures).getByText(translate(locale, 'dcim.capacity.percent', { percent: '59' })),
    ).toBeTruthy();
    expect(
      within(figures).getByText(translate(locale, 'dcim.capacity.percent', { percent: '78' })),
    ).toBeTruthy();
    const trend = screen.getByTestId('dcim-capacity-trend');
    expect(
      within(trend).getByText(translate(locale, 'dcim.capacity.trend.toWarning', { days: '8' })),
    ).toBeTruthy();
    expect(
      within(trend).getByText(translate(locale, 'dcim.capacity.trend.toCritical', { days: '21' })),
    ).toBeTruthy();
    const table = screen.getByTestId('dcim-capacity-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      'DH01-A-01',
      'DH01-A-02',
      'DH01-B-01',
    ]);
    expect(
      within(rows[0] as HTMLElement).getByText(translate(locale, 'dcim.capacity.state.critical')),
    ).toBeTruthy();
    const fit = screen.getByTestId('dcim-capacity-fit');
    expect(within(fit).getByRole('status').textContent).toBe(
      translate(locale, 'dcim.capacity.fit.result', { devices: '34', racks: '3', total: '3' }),
    );
    fireEvent.change(within(fit).getByLabelText(translate(locale, 'dcim.capacity.fit.heightU')), {
      target: { value: '4' },
    });
    // 4U: A 2 + 1 by space but 1 by power → 1; B 8 by space, 12 by power, 19 by ports → 8; C 10 → 19 devices in 3 racks.
    expect(within(fit).getByRole('status').textContent).toBe(
      translate(locale, 'dcim.capacity.fit.result', { devices: '19', racks: '3', total: '3' }),
    );
  });
});
