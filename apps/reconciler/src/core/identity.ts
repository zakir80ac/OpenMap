// REQ-CORE-013 — identity resolution. Two kinds of match: the full identity tuple of a type (always),
// and any single key that is globally unique (serial number, UUID, FQDN…). Keys that are only unique
// within a parent (ifIndex, vlanId, name) never match alone, which is what keeps interface 1 of one
// switch from colliding with interface 1 of every other switch.
import { CI_IDENTITY_KEYS, GLOBAL_IDENTITY_KEYS, type CiType, type ObservedCi } from '@openmap/contracts';

const TUPLE_PREFIX = 'tuple';

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/** Canonical tuple of all present identity values in contract precedence order; the stored identityKey. */
export function identityTuple(type: CiType, identity: Record<string, string>): string {
  return CI_IDENTITY_KEYS[type]
    .map((k) => identity[k])
    .filter((v): v is string => v !== undefined && v !== '')
    .map(norm)
    .join('|');
}

/** `type|key=value` for a globally unique key. */
export function identityKey(type: CiType, key: string, value: string): string {
  return type + '|' + key + '=' + norm(value);
}

export function tupleKey(type: CiType, identity: Record<string, string>): string {
  return type + '|' + TUPLE_PREFIX + '=' + identityTuple(type, identity);
}

/** Every lookup key an observation offers: the tuple first, then each globally unique key. */
export function identityKeysOf(ci: Pick<ObservedCi, 'type' | 'identity'>): string[] {
  const out: string[] = [];
  const tuple = identityTuple(ci.type, ci.identity);
  if (tuple !== '') out.push(tupleKey(ci.type, ci.identity));
  for (const key of CI_IDENTITY_KEYS[ci.type]) {
    const value = ci.identity[key];
    if (value !== undefined && value !== '' && GLOBAL_IDENTITY_KEYS.has(key)) out.push(identityKey(ci.type, key, value));
  }
  return out;
}

/** Globally unique (key, value) pairs of an observation, for store lookups by JSON containment. */
export function globalPairs(ci: Pick<ObservedCi, 'type' | 'identity'>): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const key of CI_IDENTITY_KEYS[ci.type]) {
    const value = ci.identity[key];
    if (value !== undefined && value !== '' && GLOBAL_IDENTITY_KEYS.has(key)) out.push({ key, value });
  }
  return out;
}

export interface IdentityIndex {
  lookup(key: string): string | undefined;
}

export type Resolution =
  | { kind: 'new' }
  | { kind: 'existing'; ciId: string; matchedKeys: string[] }
  | { kind: 'conflict'; ciIds: string[]; matchedKeys: string[] };

export function resolve(ci: Pick<ObservedCi, 'type' | 'identity'>, index: IdentityIndex): Resolution {
  const keys = identityKeysOf(ci);
  const hits = new Map<string, string[]>();
  for (const k of keys) {
    const id = index.lookup(k);
    if (id === undefined) continue;
    const list = hits.get(id) ?? [];
    list.push(k);
    hits.set(id, list);
  }
  if (hits.size === 0) return { kind: 'new' };
  if (hits.size === 1) {
    const [ciId, matchedKeys] = [...hits.entries()][0]!;
    return { kind: 'existing', ciId, matchedKeys };
  }
  return { kind: 'conflict', ciIds: [...hits.keys()], matchedKeys: [...hits.values()].flat() };
}

export class MapIdentityIndex implements IdentityIndex {
  private readonly map = new Map<string, string>();
  add(ci: Pick<ObservedCi, 'type' | 'identity'>, ciId: string): void {
    for (const k of identityKeysOf(ci)) this.map.set(k, ciId);
  }
  lookup(key: string): string | undefined {
    return this.map.get(key);
  }
  get size(): number {
    return this.map.size;
  }
}
