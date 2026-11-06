// T-198 REQ-CMDB-014 (ADR-037) — Parts in en and ar: the register with kind, model, holding CI, serial, capacity and
// localised details, the common models, the kind/text/removed filters and paging reaching the query; and a CI's Parts
// tab with its totals, removed parts on request.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { COMPONENTS } from '@openmap/constants';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { CiPartsPanel } from './CiPartsPanel';
import { orderedDetails } from './PartCells';
import { PartsView, pageRange } from './PartsView';

const GIB = 1024 ** 3;
const ci = {
  id: 'h1',
  name: 'srv-ryd-sql-0001',
  displayName: 'srv-ryd-sql-0001',
  code: 'HW-SRV',
  type: 'host',
  layer: 'hardware',
  health: 'healthy',
};
const seen = { firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-11-06T00:00:00.000Z' };
const parts = [
  {
    id: 'p1',
    kind: 'cpu',
    slot: 'CPU1',
    model: 'AMD EPYC 9354',
    manufacturer: 'AMD',
    serialNumber: null,
    partNumber: null,
    capacityBytes: null,
    firmware: null,
    details: { cores: 32, threads: 64 },
    removedAt: null,
    ...seen,
  },
  {
    id: 'p2',
    kind: 'memory',
    slot: 'CPU1 DIMM 1',
    model: null,
    manufacturer: 'Samsung',
    serialNumber: '8A1B2C3D',
    partNumber: 'M321R8GA0BB0',
    capacityBytes: 64 * GIB,
    firmware: null,
    details: { type: 'DDR5', speedMts: 4800 },
    removedAt: null,
    ...seen,
  },
  {
    id: 'p3',
    kind: 'disk',
    slot: 'Bay 1',
    model: 'Samsung PM893',
    manufacturer: null,
    serialNumber: 'S6K0NA0T',
    partNumber: null,
    capacityBytes: 960 * GIB,
    firmware: 'JXTC104Q',
    details: { media: 'ssd', transport: 'SATA' },
    removedAt: null,
    ...seen,
  },
  {
    id: 'p4',
    kind: 'disk',
    slot: 'Bay 2',
    model: 'Samsung PM893',
    manufacturer: null,
    serialNumber: 'S6K0NA0U',
    partNumber: null,
    capacityBytes: 960 * GIB,
    firmware: null,
    details: {},
    removedAt: '2026-11-05T00:00:00.000Z',
    ...seen,
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
      if (body.query.includes('CiParts')) {
        const list = body.variables['removed'] === true ? parts : parts.filter((p) => p.removedAt === null);
        return Promise.resolve(
          new Response(JSON.stringify({ data: { ci: { id: 'h1', components: list } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      const filter = (body.variables['filter'] ?? {}) as { kind?: string; includeRemoved?: boolean };
      const items = parts
        .filter(
          (p) =>
            (filter.kind === undefined || p.kind === filter.kind) &&
            (filter.includeRemoved === true || p.removedAt === null),
        )
        .map((p) => ({ ...p, ci }));
      const total = 250;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              components: {
                total,
                items,
                models: [
                  { kind: 'disk', model: 'Samsung PM893', count: 120 },
                  { kind: 'cpu', model: 'AMD EPYC 9354', count: 80 },
                ],
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('part helpers', () => {
  it('orders details and page ranges', () => {
    expect(orderedDetails({ zeta: 1, threads: 64, cores: 32 }).map(([k]) => k)).toEqual([
      'cores',
      'threads',
      'zeta',
    ]);
    expect(pageRange(0, 0)).toEqual({ from: 0, to: 0 });
    expect(pageRange(100, 50)).toEqual({ from: 101, to: 150 });
  });
});

describe.each(LOCALES)('Parts (%s)', (locale) => {
  it('lists the register, filters it and pages through it', async () => {
    render(
      <Providers locale={locale}>
        <PartsView locale={locale} />
      </Providers>,
    );
    const register = await screen.findByTestId('part-register');
    const disk = register.querySelector('[data-part="srv-ryd-sql-0001:Bay 1"]');
    if (!(disk instanceof HTMLElement)) throw new Error('disk row missing');
    expect(within(disk).getByText(translate(locale, 'parts.kind.disk'))).toBeTruthy();
    expect(within(disk).getByText('S6K0NA0T')).toBeTruthy();
    expect(within(disk).getByRole('link', { name: 'srv-ryd-sql-0001' })).toBeTruthy();
    expect(within(disk).getByText(translate(locale, 'parts.detail.media', { value: 'ssd' }))).toBeTruthy();
    const cpu = register.querySelector('[data-part="srv-ryd-sql-0001:CPU1"]');
    if (!(cpu instanceof HTMLElement)) throw new Error('cpu row missing');
    expect(within(cpu).getByText(translate(locale, 'parts.detail.cores', { value: '32' }))).toBeTruthy();
    expect(
      within(screen.getByTestId('part-models')).getByText(
        translate(locale, 'parts.models.row', {
          kind: translate(locale, 'parts.kind.disk'),
          model: 'Samsung PM893',
          count: '120',
        }),
      ),
    ).toBeTruthy();
    expect(register.querySelector('[data-part="srv-ryd-sql-0001:Bay 2"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'parts.page.next') }));
    await waitFor(() => {
      expect(calls.at(-1)?.variables['offset']).toBe(COMPONENTS.pageSize);
    });
    fireEvent.change(screen.getByLabelText(translate(locale, 'parts.filter.kind')), {
      target: { value: 'disk' },
    });
    fireEvent.click(screen.getByLabelText(translate(locale, 'parts.filter.removed')));
    await waitFor(() => {
      expect(calls.at(-1)?.variables).toEqual({
        filter: { kind: 'disk', includeRemoved: true },
        first: COMPONENTS.pageSize,
        offset: 0,
      });
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('part-register').querySelector('[data-part="srv-ryd-sql-0001:Bay 2"]'),
      ).not.toBeNull();
    });
  });

  it("shows a CI's parts with totals and its removed parts on request", async () => {
    render(
      <Providers locale={locale}>
        <CiPartsPanel ciId="h1" locale={locale} />
      </Providers>,
    );
    const panel = await screen.findByTestId('ci-parts');
    await waitFor(() => {
      expect(panel.querySelector('[data-part="memory:CPU1 DIMM 1"]')).not.toBeNull();
    });
    expect(
      within(panel).getByText(translate(locale, 'parts.firmware', { version: 'JXTC104Q' })),
    ).toBeTruthy();
    expect(panel.querySelector('[data-part="disk:Bay 2"]')).toBeNull();
    // Kind order: processors, memory, drives.
    expect([...panel.querySelectorAll('tr[data-part]')].map((r) => r.getAttribute('data-part'))).toEqual([
      'cpu:CPU1',
      'memory:CPU1 DIMM 1',
      'disk:Bay 1',
    ]);
    fireEvent.click(within(panel).getByLabelText(translate(locale, 'parts.ci.showRemoved')));
    await waitFor(() => {
      expect(panel.querySelector('[data-part="disk:Bay 2"]')).not.toBeNull();
    });
  });
});
