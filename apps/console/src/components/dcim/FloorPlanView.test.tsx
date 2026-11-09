// T-526 REQ-DCIM-003 (ADR-057) — the DCIM floor plan over stubbed GraphQL, in en and ar: rows in room order with their
// aisle, rack slots named with their heat under the chosen measure (and a rack with no reading said so), the measure
// switch recolouring the plan, and an operator moving a chosen rack to a free slot picked on the plan.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { Rack } from '@/lib/estate-queries';
import { FloorPlanView } from './FloorPlanView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/dcim',
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCan: () => () => true,
}));

function rack(
  id: string,
  row: { id: string; name: string; position: number; aisle: string },
  position: number,
  watts: [number, number] | null,
  occupied: number,
): Rack {
  const ci = (cid: string) => ({
    id: cid,
    name: cid,
    displayName: cid,
    code: cid,
    type: 'rack',
    layer: 'dc' as const,
    health: 'healthy' as const,
    attributes: { position, designKw: 10 },
  });
  return {
    ci: ci(id),
    units: 40,
    occupiedUnits: occupied,
    devices: [],
    powerFeeds: watts === null ? [] : [{ ci: ci(id + '-pdu'), ratedWatts: watts[0], currentWatts: watts[1] }],
    row: {
      id: row.id,
      displayName: row.name,
      attributes: { position: row.position, aisle: row.aisle, rackCapacity: 3 },
    },
    room: { id: 'dh1', displayName: 'DH01', attributes: {} },
  };
}

const rowA = { id: 'row-a', name: 'A', position: 1, aisle: 'cold' };
const rowB = { id: 'row-b', name: 'B', position: 2, aisle: 'hot' };
const racks = [
  rack('A-01', rowA, 1, [10_000, 9_500], 10),
  rack('A-02', rowA, 2, null, 30),
  rack('B-01', rowB, 1, [10_000, 2_000], 20),
];
const sent: Array<{ query: string; variables: Record<string, unknown> | undefined }> = [];

beforeEach(() => {
  sent.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables?: Record<string, unknown> };
      sent.push({ query: body.query, variables: body.variables });
      return Promise.resolve(
        new Response(JSON.stringify({ data: { placeRack: racks[0] } }), {
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

describe.each(LOCALES)('FloorPlanView in %s', (locale) => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>): string =>
    translate(locale, key, params);
  const pct = (v: string): string => t('dcim.floor.percent', { value: v });

  it('lays out rows with aisles and heat, switches the measure and moves a rack to a free slot', async () => {
    render(
      <Providers locale={locale}>
        <FloorPlanView locale={locale} racks={racks} />
      </Providers>,
    );
    const plan = screen.getByRole('region', { name: t('dcim.floor.plan', { room: 'DH01' }) });
    expect(within(plan).getByText(t('dcim.floor.aisle.cold'))).toBeTruthy();
    expect(within(plan).getByText(t('dcim.floor.aisle.hot'))).toBeTruthy();
    const rowSlots = within(plan).getByRole('list', { name: t('dcim.floor.row', { row: 'A' }) });
    expect(within(rowSlots).getAllByRole('button')).toHaveLength(3);
    expect(
      within(plan).getByRole('button', {
        name: t('dcim.floor.rackSlot', { row: 'A', slot: '1', rack: 'A-01', heat: pct('95') }),
      }),
    ).toBeTruthy();
    expect(
      within(plan).getByRole('button', {
        name: t('dcim.floor.rackSlot', {
          row: 'A',
          slot: '2',
          rack: 'A-02',
          heat: t('dcim.floor.noReading'),
        }),
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: t('dcim.floor.measures.occupancy') }));
    expect(
      within(plan).getByRole('button', {
        name: t('dcim.floor.rackSlot', { row: 'A', slot: '2', rack: 'A-02', heat: pct('75') }),
      }),
    ).toBeTruthy();

    fireEvent.click(
      within(plan).getByRole('button', {
        name: t('dcim.floor.rackSlot', { row: 'B', slot: '1', rack: 'B-01', heat: pct('50') }),
      }),
    );
    const form = await screen.findByRole('form', { name: t('dcim.floor.move') });
    fireEvent.click(
      within(plan).getByRole('button', { name: t('dcim.floor.freeSlot', { row: 'A', slot: '3' }) }),
    );
    expect(
      (within(form).getByRole('combobox', { name: t('dcim.floor.toRow') }) as HTMLSelectElement).value,
    ).toBe('row-a');
    fireEvent.click(within(form).getByRole('button', { name: t('dcim.floor.move') }));
    await waitFor(() => {
      expect(sent.find((s) => s.query.includes('placeRack'))?.variables).toEqual({
        rackId: 'B-01',
        rowId: 'row-a',
        position: 3,
      });
    });
  });
});
