// T-206 REQ-CMDB-034 — Utilisation in en and ar: headline counts and averages, the register hottest first with state
// tags, bars and power, the type/state/sort filters reaching the query; a CI's Utilisation tab with latest, average,
// peak and the window reaching the query; the colour rule.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UTILISATION } from '@openmap/constants';
import { LOCALES, translate } from '@openmap/i18n';
import { accents } from '@openmap/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { CiUtilisationPanel } from './CiUtilisationPanel';
import { percentAccent } from './measures';
import { UtilisationView } from './UtilisationView';

const ci = (id: string, type: string, displayName: string) => ({
  id,
  name: displayName,
  displayName,
  code: id.toUpperCase(),
  type,
  layer: 'hardware',
  health: 'healthy',
});
const rows = [
  {
    ci: ci('h1', 'host', 'srv-hot-01'),
    state: 'hot',
    cpu: 95,
    memory: 70,
    disk: 40,
    power: 610,
    observedAt: '2026-11-07T00:00:00.000Z',
  },
  {
    ci: ci('v1', 'vm', 'vm-app-01'),
    state: 'normal',
    cpu: 45,
    memory: 50,
    disk: null,
    power: null,
    observedAt: '2026-11-07T00:00:00.000Z',
  },
  {
    ci: ci('h2', 'host', 'srv-idle-01'),
    state: 'idle',
    cpu: 3,
    memory: 8,
    disk: 20,
    power: 290,
    observedAt: '2026-11-07T00:00:00.000Z',
  },
];
const series = [
  {
    measure: 'cpu',
    metric: 'host.cpu.utilisation_percent',
    unit: 'percent',
    latest: 95,
    latestAt: '2026-11-07T00:00:00.000Z',
    average: 87.5,
    peak: 95,
    points: [
      { at: '2026-11-06T22:00:00.000Z', value: 80, peak: 80 },
      { at: '2026-11-06T23:00:00.000Z', value: 95, peak: 95 },
    ],
  },
  {
    measure: 'power',
    metric: 'host.power.watts',
    unit: 'W',
    latest: 610,
    latestAt: '2026-11-07T00:00:00.000Z',
    average: 610,
    peak: 610,
    points: [{ at: '2026-11-06T23:00:00.000Z', value: 610, peak: 610 }],
  },
];
const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

beforeEach(() => {
  calls.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        query: string;
        variables: Record<string, unknown>;
      };
      calls.push(body);
      const json = body.query.includes('CiUtilisation')
        ? {
            data: { ci: { id: 'h1', utilisation: { state: 'hot', hours: body.variables['hours'], series } } },
          }
        : (() => {
            const f = (body.variables['filter'] ?? {}) as { state?: string; types?: string[] };
            const items = rows.filter(
              (r) =>
                (f.state === undefined || r.state === f.state) &&
                (f.types === undefined || f.types.includes(r.ci.type)),
            );
            return {
              data: {
                utilisation: {
                  total: items.length,
                  hot: 1,
                  idle: 1,
                  averageCpu: 47.67,
                  averageMemory: 42.67,
                  powerWatts: 900,
                  items,
                },
              },
            };
          })();
      return Promise.resolve(
        new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('percentAccent', () => {
  it('colours by distance to the hot threshold', () => {
    expect(percentAccent(UTILISATION.hotPercent)).toBe(accents.rose);
    expect(percentAccent(UTILISATION.hotPercent - 1)).toBe(accents.amber);
    expect(percentAccent(UTILISATION.idlePercent)).toBe(accents.steel);
    expect(percentAccent(50)).toBe(accents.cyan);
  });
});

describe.each(LOCALES)('Utilisation (%s)', (locale) => {
  it('lists the register and filters it', async () => {
    render(
      <Providers locale={locale}>
        <UtilisationView locale={locale} />
      </Providers>,
    );
    const register = await screen.findByTestId('utilisation-register');
    const order = [...register.querySelectorAll('tr[data-utilisation]')].map((r) =>
      r.getAttribute('data-utilisation'),
    );
    expect(order).toEqual(['srv-hot-01', 'vm-app-01', 'srv-idle-01']);
    const hot = register.querySelector('[data-utilisation="srv-hot-01"]');
    if (!(hot instanceof HTMLElement)) throw new Error('hot row missing');
    expect(within(hot).getByText(translate(locale, 'utilisation.state.hot'))).toBeTruthy();
    expect(within(hot).getByText(translate(locale, 'utilisation.watts', { value: '610' }))).toBeTruthy();
    expect(screen.getByText(translate(locale, 'utilisation.kilowatts', { value: '0.9' }))).toBeTruthy();

    fireEvent.change(screen.getByLabelText(translate(locale, 'utilisation.filter.state')), {
      target: { value: 'idle' },
    });
    fireEvent.change(screen.getByLabelText(translate(locale, 'utilisation.filter.type')), {
      target: { value: 'host' },
    });
    fireEvent.change(screen.getByLabelText(translate(locale, 'utilisation.filter.sort')), {
      target: { value: 'power' },
    });
    await waitFor(() => {
      expect(calls.at(-1)?.variables).toEqual({
        filter: { types: ['host'], state: 'idle' },
        sort: 'power',
        first: UTILISATION.pageSize,
        offset: 0,
      });
    });
    await waitFor(() => {
      expect(
        [...screen.getByTestId('utilisation-register').querySelectorAll('tr[data-utilisation]')].map((r) =>
          r.getAttribute('data-utilisation'),
        ),
      ).toEqual(['srv-idle-01']);
    });
  });

  it("shows a CI's utilisation over a window", async () => {
    render(
      <Providers locale={locale}>
        <CiUtilisationPanel ciId="h1" />
      </Providers>,
    );
    const panel = await screen.findByTestId('ci-utilisation');
    await waitFor(() => {
      expect(panel.querySelector('[data-measure="cpu"]')).not.toBeNull();
    });
    const cpu = panel.querySelector('[data-measure="cpu"]');
    if (!(cpu instanceof HTMLElement)) throw new Error('cpu card missing');
    expect(within(cpu).getByText(translate(locale, 'utilisation.percent', { value: '95' }))).toBeTruthy();
    expect(
      within(cpu).getByText(
        translate(locale, 'utilisation.ci.averagePeak', {
          average: translate(locale, 'utilisation.percent', { value: '87.5' }),
          peak: translate(locale, 'utilisation.percent', { value: '95' }),
        }),
      ),
    ).toBeTruthy();
    expect(within(panel).getByText(translate(locale, 'utilisation.state.hot'))).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText(translate(locale, 'utilisation.ci.window')), {
      target: { value: '24' },
    });
    await waitFor(() => {
      expect(calls.at(-1)?.variables).toEqual({ id: 'h1', hours: 24 });
    });
  });
});
