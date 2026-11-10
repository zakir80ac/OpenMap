// REQ-IPAM-004 (ADR-063) — switch port management shared by the API, the console and the tests: MAC addresses in one
// canonical form, a port's state read from either attribute shape collectors use (IF-MIB names such as `ifOperStatus`
// and `ifSpeedMbps`, or the SNMP collector's `operUp`, `adminUp`, `speedBps`), the MACs a port has learned, and the
// history of a port as the changes between its recorded versions. Pure functions over attribute records.
import { SWITCH_PORTS, TIME } from '@openmap/constants';

export const PORT_STATES = ['up', 'down', 'admin_down', 'unknown'] as const;
export type PortState = (typeof PORT_STATES)[number];

/** Attribute names a port's facts are read from, first match wins. */
export const SWITCH_PORT_ATTRIBUTES = {
  operStatus: ['ifOperStatus', 'operStatus'],
  operUp: ['operUp'],
  adminStatus: ['ifAdminStatus', 'adminStatus'],
  adminUp: ['adminUp'],
  speedMbps: ['ifSpeedMbps', 'speedMbps'],
  speedBps: ['speedBps'],
  alias: ['ifAlias', 'alias'],
  descr: ['ifDescr', 'descr'],
  mtu: ['ifMtu', 'mtu'],
  mac: ['ifPhysAddress', 'mac'],
  pvid: ['pvid'],
  learnedMacs: 'learnedMacs',
  learnedMacCount: 'learnedMacCount',
} as const;

/** Attribute names a CI's own MAC is read from: hosts, VMs, BMCs, interfaces and ARP-observed IP addresses. */
export const MAC_OWNER_ATTRIBUTES = ['primaryMac', 'macAddress', 'mac', 'ifPhysAddress'] as const;

/** The port facts whose changes make up a port's history. */
export const PORT_HISTORY_KEYS = ['state', 'speedMbps', 'alias', 'pvid', 'learnedMacs'] as const;
export type PortHistoryKey = (typeof PORT_HISTORY_KEYS)[number];

const HEX12 = new RegExp('^[0-9a-f]{12}$');
const SEPARATORS = new RegExp('[:.\\-\\s]', 'g');
const BPS_PER_MBPS = 1_000_000;
const UP_WORDS: readonly string[] = ['up', '1', 'connected'];
const DOWN_WORDS: readonly string[] = [
  'down',
  '2',
  'lowerlayerdown',
  'notpresent',
  'dormant',
  'disconnected',
];

/** `aa:bb:cc:dd:ee:ff` from any common spelling (colons, dashes, Cisco dotted, bare hex), or null. */
export function normaliseMac(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const hex = text.trim().toLowerCase().replace(SEPARATORS, '');
  if (!HEX12.test(hex)) return null;
  return hex.match(new RegExp('.{2}', 'g'))?.join(':') ?? null;
}

function first(attributes: Readonly<Record<string, unknown>>, names: readonly string[]): unknown {
  for (const n of names) if (attributes[n] !== undefined && attributes[n] !== null) return attributes[n];
  return undefined;
}

function flag(
  attributes: Readonly<Record<string, unknown>>,
  words: readonly string[],
  bools: readonly string[],
): boolean | null {
  const text = first(attributes, words);
  if (typeof text === 'string' || typeof text === 'number') {
    const w = String(text).toLowerCase();
    if (UP_WORDS.includes(w)) return true;
    if (DOWN_WORDS.includes(w)) return false;
  }
  const b = first(attributes, bools);
  return typeof b === 'boolean' ? b : null;
}

export function portState(attributes: Readonly<Record<string, unknown>>): PortState {
  const admin = flag(attributes, SWITCH_PORT_ATTRIBUTES.adminStatus, SWITCH_PORT_ATTRIBUTES.adminUp);
  if (admin === false) return 'admin_down';
  const oper = flag(attributes, SWITCH_PORT_ATTRIBUTES.operStatus, SWITCH_PORT_ATTRIBUTES.operUp);
  if (oper === null) return 'unknown';
  return oper ? 'up' : 'down';
}

export function portSpeedMbps(attributes: Readonly<Record<string, unknown>>): number | null {
  const mbps = first(attributes, SWITCH_PORT_ATTRIBUTES.speedMbps);
  if (typeof mbps === 'number' && mbps > 0) return mbps;
  const bps = first(attributes, SWITCH_PORT_ATTRIBUTES.speedBps);
  return typeof bps === 'number' && bps > 0 ? Math.round(bps / BPS_PER_MBPS) : null;
}

export function portText(
  attributes: Readonly<Record<string, unknown>>,
  names: readonly string[],
): string | null {
  const v = first(attributes, names);
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}

export function portNumber(
  attributes: Readonly<Record<string, unknown>>,
  names: readonly string[],
): number | null {
  const v = first(attributes, names);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The MACs a port has learned, canonical and unique, and how many it learned in all (the list may be capped). */
export function learnedMacs(attributes: Readonly<Record<string, unknown>>): {
  macs: string[];
  count: number;
} {
  const raw = attributes[SWITCH_PORT_ATTRIBUTES.learnedMacs];
  const macs = Array.isArray(raw)
    ? [
        ...new Set(
          raw
            .map((m) => normaliseMac(typeof m === 'string' ? m : null))
            .filter((m): m is string => m !== null),
        ),
      ].sort()
    : [];
  const count = attributes[SWITCH_PORT_ATTRIBUTES.learnedMacCount];
  return { macs, count: typeof count === 'number' && count >= macs.length ? count : macs.length };
}

/** A port's facts as its history compares them. */
export function portFacts(
  attributes: Readonly<Record<string, unknown>>,
): Record<PortHistoryKey, string | null> {
  const speed = portSpeedMbps(attributes);
  const pvid = portNumber(attributes, SWITCH_PORT_ATTRIBUTES.pvid);
  const macs = learnedMacs(attributes).macs;
  return {
    state: portState(attributes),
    speedMbps: speed === null ? null : String(speed),
    alias: portText(attributes, SWITCH_PORT_ATTRIBUTES.alias),
    pvid: pvid === null || pvid === 0 ? null : String(pvid),
    learnedMacs: macs.length === 0 ? null : macs.join(' '),
  };
}

export interface PortVersion {
  /** Epoch milliseconds the version became valid. */
  at: number;
  attributes: Readonly<Record<string, unknown>>;
}

export interface PortChange {
  at: number;
  key: PortHistoryKey;
  from: string | null;
  to: string | null;
}

/** The changes between consecutive versions of a port, oldest first; the first version is its baseline, not a change. */
export function portChanges(versions: readonly PortVersion[]): PortChange[] {
  const sorted = [...versions].sort((a, b) => a.at - b.at);
  const out: PortChange[] = [];
  let previous: Record<PortHistoryKey, string | null> | null = null;
  for (const v of sorted) {
    const facts = portFacts(v.attributes);
    if (previous !== null) {
      for (const key of PORT_HISTORY_KEYS)
        if (facts[key] !== previous[key]) out.push({ at: v.at, key, from: previous[key], to: facts[key] });
    }
    previous = facts;
  }
  return out;
}

/**
 * Whole days a port has not been up, from its versions: null while it is up; from the last version in which it was up
 * otherwise, or from its first version when it never was. A port down longer than SWITCH_PORTS.unusedDays is free to reuse.
 */
export function daysNotUp(versions: readonly PortVersion[], now: number): number | null {
  const sorted = [...versions].sort((a, b) => a.at - b.at);
  const last = sorted.at(-1);
  if (last === undefined || portState(last.attributes) === 'up') return null;
  let since = sorted[0]?.at ?? now;
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i];
    if (v !== undefined && portState(v.attributes) === 'up') since = sorted[i + 1]?.at ?? now;
  }
  return Math.max(0, Math.floor((now - since) / TIME.msPerDay));
}

export function isUnused(days: number | null): boolean {
  return days !== null && days >= SWITCH_PORTS.unusedDays;
}
