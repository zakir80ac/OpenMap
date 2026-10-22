// REQ-CORE-013 — identity resolution: maps observed CIs to stored ids through the contract's identity
// keys, and reports conflicts when one observation points at two different stored CIs.
import { CI_IDENTITY_KEYS, type CiType, type ObservedCi } from '@openmap/contracts';

/** `type|key=value`, lower-cased value so serials and hostnames match regardless of case. */
export function identityKey(type: CiType, key: string, value: string): string {
  return type + '|' + key + '=' + value.trim().toLowerCase();
}

/** Every identity key an observation offers, in contract precedence order. */
export function identityKeysOf(ci: Pick<ObservedCi, 'type' | 'identity'>): string[] {
  const out: string[] = [];
  for (const key of CI_IDENTITY_KEYS[ci.type]) {
    const value = ci.identity[key];
    if (value !== undefined && value !== '') out.push(identityKey(ci.type, key, value));
  }
  return out;
}

export interface IdentityIndex {
  /** Returns the stored CI id for an identity key, or undefined. */
  lookup(key: string): string | undefined;
}

export type Resolution =
  | { kind: 'new' }
  | { kind: 'existing'; ciId: string; matchedKeys: string[] }
  | { kind: 'conflict'; ciIds: string[]; matchedKeys: string[] };

/** Resolves an observation. A conflict means the same device was previously stored as two CIs; the reconciler emits an event and merges nothing. */
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
