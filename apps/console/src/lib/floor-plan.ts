// REQ-DCIM-003 (ADR-057) — the room floor plan as a pure model: each room's rows in their order along the room (the
// row's `position`), each row's rack slots (its `rackCapacity`, or as far as its furthest rack), the rack in each
// slot and its heat under a chosen measure. Only what was observed is coloured: a rack with no reading for the
// measure has no heat, never a guessed one.
import { BSM, DCIM, POWER } from '@openmap/constants';
import type { UiState } from '@openmap/ui';
import type { Rack } from './estate-queries';

export const HEAT_MEASURES = ['power', 'design', 'occupancy'] as const;
export type HeatMeasure = (typeof HEAT_MEASURES)[number];
export const AISLES = ['cold', 'hot'] as const;
export type Aisle = (typeof AISLES)[number];

export interface FloorSlot {
  position: number;
  rack: Rack | null;
  /** Percent under the measure, or null when the rack has no reading for it (or the slot is empty). */
  heat: number | null;
}

export interface FloorRow {
  id: string | null;
  name: string;
  position: number;
  aisle: Aisle | null;
  capacity: number | null;
  slots: FloorSlot[];
}

export interface FloorRoom {
  id: string;
  name: string;
  rows: FloorRow[];
}

function num(attributes: Record<string, unknown> | undefined, key: string): number | null {
  const v = attributes?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function percent(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * BSM.percentScale : null;
}

/** A rack's heat: measured power against its feeds' rating or its design power, or units in use against its height. */
export function heatOf(rack: Rack, measure: HeatMeasure): number | null {
  if (measure === 'occupancy') return percent(rack.occupiedUnits, rack.units);
  const current = rack.powerFeeds.reduce((sum, f) => sum + f.currentWatts, 0);
  if (rack.powerFeeds.length === 0) return null;
  if (measure === 'power')
    return percent(
      current,
      rack.powerFeeds.reduce((sum, f) => sum + f.ratedWatts, 0),
    );
  const designKw = num(rack.ci.attributes, 'designKw');
  return designKw === null ? null : percent(current, designKw * POWER.wattsPerKilowatt);
}

/** The state colour band of a heat: under the warning line, between it and the critical line, over the critical line. */
export function heatState(heat: number | null): UiState {
  if (heat === null) return 'unknown';
  if (heat >= DCIM.criticalPowerPercent) return 'down';
  return heat >= DCIM.warnPowerPercent ? 'at_risk' : 'healthy';
}

function aisleOf(value: unknown): Aisle | null {
  return value === 'cold' || value === 'hot' ? value : null;
}

/** Rooms with their rows and slots. Racks in no row share one row per room named by the caller. */
export function buildFloorPlan(
  racks: ReadonlyArray<Rack>,
  measure: HeatMeasure,
  unplacedLabel: string,
): FloorRoom[] {
  const rooms = new Map<
    string,
    {
      name: string;
      rows: Map<string, { row: Omit<FloorRow, 'slots'>; racks: Array<{ rack: Rack; position: number }> }>;
    }
  >();
  for (const rack of racks) {
    const roomId = rack.room?.id ?? '';
    const room = rooms.get(roomId) ?? { name: rack.room?.displayName ?? unplacedLabel, rows: new Map() };
    rooms.set(roomId, room);
    const rowKey = rack.row?.id ?? '';
    const entry = room.rows.get(rowKey) ?? {
      row: {
        id: rack.row?.id ?? null,
        name: rack.row?.displayName ?? unplacedLabel,
        position: num(rack.row?.attributes, 'position') ?? Number.MAX_SAFE_INTEGER,
        aisle: aisleOf(rack.row?.attributes['aisle']),
        capacity: num(rack.row?.attributes, 'rackCapacity'),
      },
      racks: [],
    };
    room.rows.set(rowKey, entry);
    entry.racks.push({ rack, position: num(rack.ci.attributes, 'position') ?? entry.racks.length + 1 });
  }
  return [...rooms.entries()]
    .map(([id, room]) => ({
      id,
      name: room.name,
      rows: [...room.rows.values()]
        .map(({ row, racks: placed }) => {
          // Two racks reporting one slot both stay visible: the later one takes the next slot past the row.
          const bySlot = new Map<number, Rack>();
          let next = Math.max(row.capacity ?? 0, ...placed.map((p) => p.position));
          for (const p of placed) {
            if (bySlot.has(p.position)) bySlot.set((next += 1), p.rack);
            else bySlot.set(p.position, p.rack);
          }
          const slots = Array.from({ length: next }, (_, i) => {
            const here = bySlot.get(i + 1) ?? null;
            return { position: i + 1, rack: here, heat: here === null ? null : heatOf(here, measure) };
          });
          return { ...row, slots };
        })
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
