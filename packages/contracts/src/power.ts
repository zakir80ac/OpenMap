// REQ-DCIM-004 (ADR-058) — the power chain and its redundancy: UPS → power circuit → PDU → device, each link a
// `powered_by` relationship, the device's carrying the feed (A/B), the PSU and the PDU outlet. Capacity comes from the
// ratings the collectors and the estate report (a UPS's kW, a circuit's amps, volts and phases, a PDU's amps and
// volts); load from what was measured. The assessment says what fails when one side of a redundant pair is lost.
import { POWER } from '@openmap/constants';
import { z } from 'zod';

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
