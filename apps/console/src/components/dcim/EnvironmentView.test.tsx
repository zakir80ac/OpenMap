// T-541 REQ-DCIM-006 (ADR-060) — the DCIM Environment view over stubbed GraphQL, in en and ar: the room's totals and
// humidity state, each rack's inlet, outlet, rise and its temperature and airflow states, the cooling units, and a
// window change re-reading the room.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { Rack } from '@/lib/estate-queries';
import { EnvironmentView } from './EnvironmentView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/dcim',
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => children }));

const environment = {
  humidityRh: 65,
  humidityState: 'warning',
  summary: { racks: 2, normal: 0, warning: 1, critical: 1, unknown: 0, hottestInletC: 34 },
  racks: [
    {
      rack: { id: 'r1', name: 'R01' },
      inletC: 29,
      outletC: 51,
      riseC: 22,
      latestAt: '2026-11-09T18:00:00.000Z',
      temperatureState: 'warning',
      airflowState: 'warning',
      state: 'warning',
      inletSeries: [
        { at: '2026-11-09T17:00:00.000Z', value: 28 },
        { at: '2026-11-09T18:00:00.000Z', value: 29 },
      ],
    },
    {
      rack: { id: 'r2', name: 'R02' },
      inletC: 34,
      outletC: null,
      riseC: null,
      latestAt: '2026-11-09T18:00:00.000Z',
      temperatureState: 'critical',
      airflowState: 'unknown',
      state: 'critical',
      inletSeries: [],
    },
  ],
  coolingUnits: [
    {
      unit: { id: 'c1', name: 'CRAC-1' },
      supplyC: 16,
      returnC: 28,
      humidityRh: 45,
      capacityPercent: 70,
      state: 'normal',
    },
  ],
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
        new Response(JSON.stringify({ data: { roomEnvironment: environment } }), {
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

describe.each(LOCALES)('EnvironmentView in %s', (locale) => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string =>
    translate(locale, key, params);

  it('shows rack temperatures with their states and the cooling units, and changes the window', async () => {
    render(
      <Providers locale={locale}>
        <EnvironmentView racks={racks} />
      </Providers>,
    );
    const table = await screen.findByRole('table', { name: t('dcim.env.racks.title') });
    const r1 = within(table).getByText('R01').closest('tr');
    if (r1 === null) throw new Error('row');
    expect(within(r1).getByText(t('dcim.env.state.temperature.warning'))).toBeTruthy();
    expect(within(r1).getByText(t('dcim.env.state.airflow.warning'))).toBeTruthy();
    expect(within(table).getByText(t('dcim.env.state.temperature.critical'))).toBeTruthy();
    expect(screen.getByText(t('dcim.env.state.humidity.warning'))).toBeTruthy();
    const cooling = screen.getByRole('table', { name: t('dcim.env.cooling.title') });
    expect(within(cooling).getByText('CRAC-1')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: t('dcim.monitor.window') }), {
      target: { value: '720' },
    });
    await waitFor(() => {
      expect(sent.some((v) => v?.['hours'] === 720 && v['roomId'] === 'dh1')).toBe(true);
    });
  });
});
