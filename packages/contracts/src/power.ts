// REQ-DCIM-004 (ADR-058) — the power chain and its redundancy: UPS → power circuit → PDU → device, each link a
// `powered_by` relationship, the device's carrying the feed (A/B), the PSU and the PDU outlet. Capacity comes from the
// ratings the collectors and the estate report (a UPS's kW, a circuit's amps, volts and phases, a PDU's amps and
// volts); load from what was measured. The assessment says what fails when one side of a redundant pair is lost.
import { BSM, POWER, TIME } from '@openmap/constants';
import { z } from 'zod';

const PERCENT_SCALE = BSM.percentScale;
const MS_PER_HOUR = TIME.msPerHour;

/** Attribute names on power CIs and on the `powered_by` relationship from a device to a PDU. */
export const POWER_ATTRIBUTES = {
  feed: 'feed',
  psu: 'psu',
  outlet: 'outlet',
  outlets: 'outlets',
  ratedKw: 'ratedKw',
  loadPercent: 'loadPercent',
  runtimeMinutes: 'batteryRuntimeMinutes',
  ratedAmps: 'ratedAmps',
  voltage: 'voltage',
  phases: 'phases',
} as const;

export const POWER_FINDING_KINDS = [
  /** A device fed from one PDU only: one PDU, circuit or UPS failure takes it down. */
  'single_corded',
  /** A device with several cords, all on the same feed: losing that feed takes it down. */
  'same_feed',
  /** If one PDU of a rack's pair fails, its partner would carry both loads, more than it is rated for. */
  'pdu_failover_overload',
  /** If one circuit of a room's pair fails, its partner would carry both loads, more than it is rated for. */
  'circuit_failover_overload',
  /** If one UPS of a pair fails, its partner would carry both loads, more than it is rated for. */
  'ups_failover_overload',
  /** A UPS whose battery runtime is under POWER.minUpsRuntimeMinutes. */
  'ups_low_runtime',
  /** A PDU with more devices plugged into it than it has outlets. */
  'outlets_exceeded',
] as const;
export type PowerFindingKind = (typeof POWER_FINDING_KINDS)[number];

/** Rated watts of a circuit: √3 × V × A for three phases, V × A otherwise. */
export function circuitRatedWatts(ratedAmps: number, voltage: number, phases: number): number {
  return Math.round(ratedAmps * voltage * (phases === POWER.threePhase ? POWER.threePhaseFactor : 1));
}

export interface PowerSourceNode {
  id: string;
  kind: 'ups' | 'power_circuit' | 'pdu';
  /** The side of the redundant pair (A or B), when reported. */
  feed: string | null;
  ratedWatts: number | null;
  loadWatts: number | null;
  /** The pair this source belongs to: a rack for PDUs, a room for circuits, a room for UPS units. */
  group: string | null;
  outlets: number | null;
  runtimeMinutes: number | null;
}

export interface PowerCord {
  deviceId: string;
  pduId: string;
  feed: string | null;
}

export interface PowerFinding {
  kind: PowerFindingKind;
  /** The device or source the finding is about. */
  ciId: string;
  /** The partner that would carry the load (failover findings). */
  partnerId: string | null;
  /** What is compared and its limit: watts for a failover finding, devices against outlets for outlets_exceeded. */
  load: number | null;
  capacity: number | null;
}

/**
 * Assesses the chain: devices on one PDU or one feed; for each pair of sources (two PDUs of a rack, two circuits or two
 * UPS units of a room), whether either one alone could carry both loads; UPS runtime; outlets over their count.
 * Sources with no rating or no measured load are not judged (nothing is assumed).
 */
export function assessPower(sources: readonly PowerSourceNode[], cords: readonly PowerCord[]): PowerFinding[] {
  const findings: PowerFinding[] = [];
  const byDevice = new Map<string, PowerCord[]>();
  for (const c of cords) byDevice.set(c.deviceId, [...(byDevice.get(c.deviceId) ?? []), c]);
  for (const [deviceId, list] of byDevice) {
    const pdus = new Set(list.map((c) => c.pduId));
    const feeds = new Set(list.map((c) => c.feed).filter((f): f is string => f !== null));
    if (pdus.size === 1) findings.push({ kind: 'single_corded', ciId: deviceId, partnerId: null, load: null, capacity: null });
    else if (feeds.size === 1) findings.push({ kind: 'same_feed', ciId: deviceId, partnerId: null, load: null, capacity: null });
  }

  const pairKind = { pdu: 'pdu_failover_overload', power_circuit: 'circuit_failover_overload', ups: 'ups_failover_overload' } as const;
  const groups = new Map<string, PowerSourceNode[]>();
  for (const s of sources) if (s.group !== null) groups.set(s.kind + '|' + s.group, [...(groups.get(s.kind + '|' + s.group) ?? []), s]);
  for (const members of groups.values()) {
    const total = members.reduce((sum, m) => sum + (m.loadWatts ?? 0), 0);
    if (members.length < 2 || members.some((m) => m.loadWatts === null)) continue;
    for (const survivor of members) {
      if (survivor.ratedWatts === null || survivor.ratedWatts <= 0 || total <= survivor.ratedWatts) continue;
      const lost = members.find((m) => m.id !== survivor.id);
      findings.push({ kind: pairKind[survivor.kind], ciId: survivor.id, partnerId: lost?.id ?? null, load: total, capacity: survivor.ratedWatts });
    }
  }

  for (const s of sources) {
    if (s.kind === 'ups' && s.runtimeMinutes !== null && s.runtimeMinutes < POWER.minUpsRuntimeMinutes)
      findings.push({ kind: 'ups_low_runtime', ciId: s.id, partnerId: null, load: null, capacity: null });
    if (s.kind === 'pdu' && s.outlets !== null) {
      const plugged = cords.filter((c) => c.pduId === s.id).length;
      if (plugged > s.outlets) findings.push({ kind: 'outlets_exceeded', ciId: s.id, partnerId: null, load: plugged, capacity: s.outlets });
    }
  }
  return findings;
}

export const powerConnectionInputSchema = z.object({
  deviceId: z.uuid(),
  pduId: z.uuid(),
  outlet: z.number().int().positive().nullable(),
  psu: z.number().int().positive().nullable(),
});
export type PowerConnectionInput = z.infer<typeof powerConnectionInputSchema>;

// REQ-DCIM-005 (ADR-059) — power monitoring, thresholds and billing by outlet.

/** Metric names: a PDU's total draw and one outlet's draw (the outlet is a `power_feed` CI), in watts. */
export const POWER_METRICS = { pdu: 'dcim.power.watts', outlet: 'dcim.outlet.watts' } as const;
export const POWER_STATES = ['normal', 'warning', 'critical', 'unknown'] as const;
export type PowerState = (typeof POWER_STATES)[number];

/** A tenant's power thresholds (percent of a PDU's rating) and its energy tariff; no tariff means no price is shown. */
export const powerSettingsSchema = z
  .object({
    warnPercent: z.number().positive().max(PERCENT_SCALE),
    criticalPercent: z.number().positive().max(PERCENT_SCALE),
    tariffPerKwh: z.number().nonnegative().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/u).nullable(),
  })
  .refine((s) => s.warnPercent < s.criticalPercent, { path: ['criticalPercent'], message: 'the critical line is above the warning line' })
  .refine((s) => (s.tariffPerKwh === null) === (s.currency === null), { path: ['currency'], message: 'a tariff needs its currency' });
export type PowerSettings = z.infer<typeof powerSettingsSchema>;

/** The band of a measured draw against a rating; unknown without either. */
export function powerState(loadWatts: number | null, ratedWatts: number | null, settings: Pick<PowerSettings, 'warnPercent' | 'criticalPercent'>): PowerState {
  if (loadWatts === null || ratedWatts === null || ratedWatts <= 0) return 'unknown';
  const percent = (loadWatts / ratedWatts) * PERCENT_SCALE;
  if (percent >= settings.criticalPercent) return 'critical';
  return percent >= settings.warnPercent ? 'warning' : 'normal';
}

export interface WattSample {
  /** Epoch milliseconds. */
  at: number;
  watts: number;
}

export interface Energy {
  /** Energy between the first and last sample inside the window (trapezoid rule), kWh. */
  kwh: number;
  /** Hours of the window the samples span; energy outside it is not guessed. */
  coveredHours: number;
  samples: number;
}

/** Integrates measured draw over a window: only between samples, never extrapolated past the first or last one. */
export function energyOf(samples: readonly WattSample[], fromMs: number, toMs: number): Energy {
  const inside = samples.filter((s) => s.at >= fromMs && s.at <= toMs).sort((a, b) => a.at - b.at);
  let wattHours = 0;
  for (let i = 1; i < inside.length; i += 1) {
    const a = inside[i - 1];
    const b = inside[i];
    if (a === undefined || b === undefined) continue;
    wattHours += ((a.watts + b.watts) / 2) * ((b.at - a.at) / MS_PER_HOUR);
  }
  const first = inside[0];
  const last = inside.at(-1);
  return {
    kwh: wattHours / POWER.wattsPerKilowatt,
    coveredHours: first === undefined || last === undefined ? 0 : (last.at - first.at) / MS_PER_HOUR,
    samples: inside.length,
  };
}

/** A PDU's rating in watts from what the collector reported: watts, or amps × volts (230 V when only amps). */
export function pduRatedWatts(attributes: Record<string, unknown>): number | null {
  const num = (k: string): number | null => (typeof attributes[k] === 'number' && Number.isFinite(attributes[k]) ? attributes[k] : null);
  const watts = num('ratedWatts');
  if (watts !== null) return watts;
  const amps = num(POWER_ATTRIBUTES.ratedAmps);
  return amps === null ? null : Math.round(amps * (num('inputVoltage') ?? POWER.defaultInputVoltage));
}
