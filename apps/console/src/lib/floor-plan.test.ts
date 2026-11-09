// T-525 REQ-DCIM-003 (ADR-057) — the floor plan model: rooms with their rows in room order (row position), each row's
// slots up to its capacity with the rack in each, racks without a row in one row per room, two racks on one slot both
// kept, and heat under each measure (power against the feeds' rating, against design power, occupancy) with no heat
// where nothing was measured, banded by the DCIM thresholds.
import { DCIM } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import type { Rack } from './estate-queries';
import { buildFloorPlan, heatOf, heatState } from './floor-plan';
import type { CiSummary } from './queries';

function ci(
  id: string,
  attributes: Record<string, unknown> = {},
): CiSummary & { attributes: Record<string, unknown> } {
  return {
    id,
    name: id,
    displayName: id,
    code: id,
    type: 'rack',
    layer: 'dc',
    health: 'healthy',
    attributes,
  };
}

function rack(
  id: string,
  o: {
    room?: string;
    row?: { id: string; position: number; aisle?: string; capacity?: number };
    position?: number;
    watts?: [number, number];
    designKw?: number;
    occupied?: number;
  },
): Rack {
  return {
    ci: ci(id, { position: o.position, designKw: o.designKw }),
    units: 40,
    occupiedUnits: o.occupied ?? 0,
    devices: [],
    powerFeeds:
      o.watts === undefined
        ? []
        : [{ ci: ci(id + '-pdu'), ratedWatts: o.watts[0], currentWatts: o.watts[1] }],
    row:
      o.row === undefined
        ? null
        : {
            id: o.row.id,
            displayName: 'Row ' + o.row.id,
            attributes: { position: o.row.position, aisle: o.row.aisle, rackCapacity: o.row.capacity },
          },
    room: o.room === undefined ? null : { id: o.room, displayName: 'Room ' + o.room, attributes: {} },
  };
}

describe('floor plan model', () => {
  const rowA = { id: 'a', position: 2, aisle: 'hot', capacity: 4 };
  const rowB = { id: 'b', position: 1, aisle: 'cold', capacity: 3 };
  const racks = [
    rack('r1', { room: 'dh1', row: rowA, position: 1, watts: [10_000, 5_000], designKw: 8, occupied: 20 }),
    rack('r2', { room: 'dh1', row: rowA, position: 3, watts: [10_000, 9_500] }),
    rack('r3', { room: 'dh1', row: rowB, position: 2 }),
    rack('r4', { room: 'dh1', row: rowB, position: 2 }),
    rack('loose', { room: 'dh1' }),
    rack('r9', { room: 'dh2', row: { id: 'c', position: 1 }, position: 1 }),
  ];

  it('lays rooms out by row position with each row slotted to its capacity', () => {
    const plan = buildFloorPlan(racks, 'power', 'Unplaced');
    expect(plan.map((r) => r.name)).toEqual(['Room dh1', 'Room dh2']);
    const dh1 = plan[0];
    expect(dh1?.rows.map((r) => r.name)).toEqual(['Row b', 'Row a', 'Unplaced']);
    const a = dh1?.rows[1];
    expect(a).toMatchObject({ id: 'a', aisle: 'hot', capacity: 4 });
    expect(a?.slots.map((s) => s.rack?.ci.id ?? null)).toEqual(['r1', null, 'r2', null]);
    // Two racks on slot 2 of row b: the later one moves past the row's three slots.
    expect(dh1?.rows[0]?.slots.map((s) => s.rack?.ci.id ?? null)).toEqual([null, 'r3', null, 'r4']);
    expect(dh1?.rows[2]?.slots.map((s) => s.rack?.ci.id)).toEqual(['loose']);
  });

  it('heats racks by the measure, leaving unmeasured racks without heat', () => {
    const [r1, r2, r3] = racks;
    if (r1 === undefined || r2 === undefined || r3 === undefined) throw new Error('fixture');
    expect(heatOf(r1, 'power')).toBe(50);
    expect(heatOf(r1, 'design')).toBe(62.5);
    expect(heatOf(r1, 'occupancy')).toBe(50);
    expect(heatOf(r2, 'design')).toBeNull();
    expect(heatOf(r3, 'power')).toBeNull();
    const plan = buildFloorPlan(racks, 'power', 'Unplaced');
    expect(plan[0]?.rows[1]?.slots[2]?.heat).toBe(95);
    expect(heatState(null)).toBe('unknown');
    expect(heatState(DCIM.warnPowerPercent - 1)).toBe('healthy');
    expect(heatState(DCIM.warnPowerPercent)).toBe('at_risk');
    expect(heatState(DCIM.criticalPowerPercent)).toBe('down');
  });
});
