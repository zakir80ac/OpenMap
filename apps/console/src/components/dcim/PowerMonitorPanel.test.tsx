// T-535 REQ-DCIM-005 (ADR-059) — the power monitoring panel over stubbed GraphQL, in en and ar: the room's energy and
// cost, each PDU with its draw, latest against rating, state and energy, billing by device with its cost centre, a
// window change re-reading the room, and an administrator saving the lines and tariff.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { PowerMonitorPanel } from './PowerMonitorPanel';

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
const monitor = {
  settings: { warnPercent: 70, criticalPercent: 90, tariffPerKwh: 0.25, currency: 'SAR' },
  hours: 24,
  totalKwh: 6.4,
  totalCost: 1.6,
  pdus: [
    {
      pdu: ci('R01 PDU-A', 'pdu'),
      rack: ci('R01', 'rack'),
      feed: 'A',
      ratedWatts: 3_680,
      latestWatts: 3_400,
      latestAt: '2026-11-09T18:00:00.000Z',
      state: 'critical',
      peakWatts: 3_400,
      series: [
        { at: '2026-11-09T16:00:00.000Z', watts: 3_000 },
        { at: '2026-11-09T18:00:00.000Z', watts: 3_400 },
      ],
      energyKwh: 6.4,
      coveredHours: 2,
      cost: 1.6,
    },
  ],
  devices: [
    {
      device: ci('srv-01', 'host'),
      costCentre: ci('CC-Cards', 'cost_centre'),
      outlets: 1,
      energyKwh: 2,
      cost: 0.5,
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
      const body = JSON.parse(String(init.body)) as { query: string; variables?: Record<string, unknown> };
      sent.push({ query: body.query, variables: body.variables });
      const data = body.query.includes('updatePowerSettings')
        ? {
            updatePowerSettings: { warnPercent: 60, criticalPercent: 85, tariffPerKwh: 0.3, currency: 'SAR' },
          }
        : { powerMonitor: monitor };
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

describe.each(LOCALES)('PowerMonitorPanel in %s', (locale) => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string =>
    translate(locale, key, params);

  it('shows draw, state, energy and billing, changes the window and saves the lines', async () => {
    render(
      <Providers locale={locale}>
        <PowerMonitorPanel roomId="dh1" />
      </Providers>,
    );
    const pdus = await screen.findByRole('table', { name: t('dcim.monitor.pdus') });
    expect(within(pdus).getByText('R01 PDU-A')).toBeTruthy();
    expect(within(pdus).getByText(t('dcim.monitor.states.critical'))).toBeTruthy();
    const billing = screen.getByRole('table', { name: t('dcim.monitor.billing.title') });
    expect(within(billing).getByText('srv-01')).toBeTruthy();
    expect(within(billing).getByText('CC-Cards')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: t('dcim.monitor.window') }), {
      target: { value: '168' },
    });
    await waitFor(() => {
      expect(sent.some((s) => s.query.includes('powerMonitor') && s.variables?.['hours'] === 168)).toBe(true);
    });

    const form = await screen.findByRole('form', { name: t('dcim.monitor.settings') });
    fireEvent.change(within(form).getByRole('spinbutton', { name: t('dcim.monitor.warnPercent') }), {
      target: { value: '60' },
    });
    fireEvent.change(within(form).getByRole('spinbutton', { name: t('dcim.monitor.criticalPercent') }), {
      target: { value: '85' },
    });
    fireEvent.change(within(form).getByRole('spinbutton', { name: t('dcim.monitor.tariff') }), {
      target: { value: '0.3' },
    });
    fireEvent.click(within(form).getByRole('button', { name: t('dcim.monitor.saveSettings') }));
    await waitFor(() => {
      expect(sent.find((s) => s.query.includes('updatePowerSettings'))?.variables).toEqual({
        input: { warnPercent: 60, criticalPercent: 85, tariffPerKwh: 0.3, currency: 'SAR' },
      });
    });
  });
});
