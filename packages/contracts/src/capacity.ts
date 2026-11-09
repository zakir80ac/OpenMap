// REQ-DCIM-007 (ADR-061) — capacity planning arithmetic shared by the API, the console and the tests: rack space as
// free unit blocks, the state of a used fraction against the tenant's lines, a least-squares trend over daily load
// and the days left to a line at that trend, and how many devices of a given size, draw and port count a rack
// still takes. Pure functions: every figure the Capacity view shows is one of these applied to stored data.
import { BSM } from '@openmap/constants';
import { z } from 'zod';

const PERCENT_SCALE = BSM.percentScale;
/** Tolerance when a day count lands a floating-point hair above a whole number. */
const DAYS_EPSILON = 1e-9;

export const CAPACITY_STATES = ['normal', 'warning', 'critical', 'unknown'] as const;
export type CapacityState = (typeof CAPACITY_STATES)[number];
export const capacityStateSchema = z.enum(CAPACITY_STATES);

/** Attribute names the capacity view reads from network devices and their interfaces. */
export const PORT_ATTRIBUTES = {
  /** A device's physical port count, when the collector reports one; interfaces are counted otherwise. */
  portCount: ['portCount', 'ports'],
  /** An interface's operational state as IF-MIB and the agents report it. */
  operStatus: ['ifOperStatus', 'operStatus'],
  /** Values of operStatus that mean a cable is live on the port. */
  upValues: ['up', '1', 'connected'],
} as const;

/** Attribute names of a cooling unit's rated capacity, in kW. */
export const COOLING_ATTRIBUTES = { capacityKw: ['coolingKw', 'capacityKw', 'ratedKw'] } as const;

/** CI types whose interfaces count as patchable ports. */
export const PORT_DEVICE_TYPES = ['network_device', 'load_balancer', 'fc_switch', 'patch_panel'] as const;

export interface UnitBlock {
  /** Lowest unit of the block (1-based). */
  start: number;
  height: number;
}

/** Percent used, or null when nothing is installed to measure against. */
export function usedPercent(used: number, total: number): number | null {
  return total > 0 ? (used / total) * PERCENT_SCALE : null;
}

/** The state of a used fraction against the warning and critical lines (percent of total). */
export function capacityState(
  percent: number | null,
  warnPercent: number,
  criticalPercent: number,
): CapacityState {
  if (percent === null || !Number.isFinite(percent)) return 'unknown';
  if (percent >= criticalPercent) return 'critical';
  if (percent >= warnPercent) return 'warning';
  return 'normal';
}

/** The worse of two states; unknown never hides a judged state. */
export function worstCapacityState(states: readonly CapacityState[]): CapacityState {
  const order: Record<CapacityState, number> = { unknown: 0, normal: 1, warning: 2, critical: 3 };
  let worst: CapacityState = 'unknown';
  for (const s of states) if (order[s] > order[worst]) worst = s;
  return worst;
}

/** Contiguous free unit blocks of a rack, lowest first; devices past the top or overlapping are clipped, not counted twice. */
export function freeBlocks(units: number, occupied: ReadonlyArray<UnitBlock>): UnitBlock[] {
  if (units <= 0) return [];
  const taken = new Array<boolean>(units).fill(false);
  for (const o of occupied) {
    const from = Math.max(1, Math.floor(o.start));
    const to = Math.min(units, from + Math.max(1, Math.floor(o.height)) - 1);
    for (let u = from; u <= to; u++) taken[u - 1] = true;
  }
  const out: UnitBlock[] = [];
  let start = 0;
  for (let u = 1; u <= units + 1; u++) {
    const free = u <= units && !taken[u - 1];
    if (free && start === 0) start = u;
    if (!free && start !== 0) {
      out.push({ start, height: u - start });
      start = 0;
    }
  }
  return out;
}

export function largestFreeBlock(units: number, occupied: ReadonlyArray<UnitBlock>): number {
  return freeBlocks(units, occupied).reduce((max, b) => Math.max(max, b.height), 0);
}

export interface TrendPoint {
  /** Epoch milliseconds. */
  at: number;
  value: number;
}

export interface Trend {
  /** Change per day in the value's unit. */
  slopePerDay: number;
  /** The fitted value now (at the last point). */
  fitted: number;
  points: number;
}

/** Least-squares line through daily points; null below `minPoints`, so two readings never make a forecast. */
export function linearTrend(
  points: ReadonlyArray<TrendPoint>,
  minPoints: number,
  msPerDay: number,
): Trend | null {
  if (points.length < minPoints) return null;
  const xs = points.map((p) => p.at / msPerDay);
  const ys = points.map((p) => p.value);
  const n = points.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - meanX;
    sxx += dx * dx;
    sxy += dx * ((ys[i] ?? 0) - meanY);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const lastX = xs[n - 1] ?? meanX;
  return { slopePerDay: slope, fitted: meanY + slope * (lastX - meanX), points: n };
}

/** Whole days until `current` reaches `target` at `slopePerDay`; 0 when already there, null when not rising. */
export function daysUntil(current: number, slopePerDay: number, target: number): number | null {
  if (current >= target) return 0;
  if (slopePerDay <= 0) return null;
  // Binary floating point puts (5.6 − 3.4) / 0.1 a hair above 22; the epsilon keeps a whole number of days whole.
  return Math.ceil((target - current) / slopePerDay - DAYS_EPSILON);
}

export interface DeviceSpec {
  heightU: number;
  watts: number;
  ports: number;
}

export interface RackHeadroom {
  largestFreeBlock: number;
  freeUnits: number;
  freeWatts: number;
  freePorts: number;
}

/**
 * How many devices of the spec a rack still takes: bounded by the free units (each device needs a contiguous block of
 * its height, so blocks are packed greedily), by the power headroom and by the free ports. A zero in the spec means
 * that dimension does not constrain.
 */
export function fitsInRack(
  blocks: ReadonlyArray<UnitBlock>,
  headroom: RackHeadroom,
  spec: DeviceSpec,
): number {
  const height = Math.max(1, Math.floor(spec.heightU));
  const bySpace = blocks.reduce((n, b) => n + Math.floor(b.height / height), 0);
  const byPower = spec.watts > 0 ? Math.floor(headroom.freeWatts / spec.watts) : Number.POSITIVE_INFINITY;
  const byPorts = spec.ports > 0 ? Math.floor(headroom.freePorts / spec.ports) : Number.POSITIVE_INFINITY;
  const fit = Math.min(bySpace, byPower, byPorts);
  return Number.isFinite(fit) ? Math.max(0, fit) : Math.max(0, bySpace);
}

export const deviceSpecSchema = z.object({
  heightU: z.number().int().positive(),
  watts: z.number().nonnegative(),
  ports: z.number().int().nonnegative(),
});
