// REQ-CORE-013 — identity resolution. Three kinds of match (packages/contracts identity.ts, ADR-044, ADR-045):
// - the full identity tuple of a type;
// - the ref key, the tuple with each `*Ref` value resolved to the id of the CI it names, so a load balancer naming a
//   pool member by its IP and the host's agent naming the same listener by the host's UUID describe one CI;
// - any single key that is globally unique (serial number, UUID, FQDN…), scoped by its issuer where the contract says
//   so (a SaaS tenant id per vendor, a cloud resource id per provider).
// Keys that are only unique within a parent (ifIndex, vlanId, name) never match alone, which is what keeps interface 1
// of one switch from colliding with interface 1 of every other switch.
import { globalMatches, identityKeysOf, identityTuple, MapRefIndex, refKeyOf, tupleKey, type IdentityOf, type RefResolver } from '@openmap/contracts';

export { identityKeysOf, identityTuple, MapRefIndex, refKeyOf, tupleKey };
export type { RefResolver };

/** Globally unique identity values of an observation, as the objects a stored identity must contain, for store lookups. */
export function globalPairs(ci: IdentityOf): Array<Record<string, string>> {
  return globalMatches(ci).map((g) => g.values);
}

export interface IdentityIndex {
  lookup(key: string): string | undefined;
}

export type Resolution =
  | { kind: 'new' }
  | { kind: 'existing'; ciId: string; matchedKeys: string[] }
  | { kind: 'conflict'; ciIds: string[]; matchedKeys: string[] };

/**
 * Finds the stored CI an observation describes. When the observation's refs resolve, its ref key stands in for the raw
 * tuple: a CI stored under the same raw tuple is either that same CI or a copy whose refs are still pending, which the
 * pending pass folds into the ref key's owner.
 */
export function resolve(ci: IdentityOf, index: IdentityIndex, refKey: string | null = null): Resolution {
  const hits = new Map<string, string[]>();
  const hit = (k: string, id: string): void => {
    const list = hits.get(id) ?? [];
    list.push(k);
    hits.set(id, list);
  };
  const raw = identityTuple(ci.type, ci.identity) !== '' ? tupleKey(ci.type, ci.identity) : null;
  const byRef = refKey === null ? undefined : index.lookup(refKey);
  if (byRef !== undefined && refKey !== null) hit(refKey, byRef);
  else if (raw !== null) {
    const id = index.lookup(raw);
    if (id !== undefined) hit(raw, id);
  }
  for (const g of globalMatches(ci)) {
    const id = index.lookup(g.key);
    if (id !== undefined) hit(g.key, id);
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
  add(ci: IdentityOf, ciId: string, refKey: string | null = null): void {
    for (const k of identityKeysOf(ci, refKey)) this.map.set(k, ciId);
  }
  lookup(key: string): string | undefined {
    return this.map.get(key);
  }
  get size(): number {
    return this.map.size;
  }
}

/** Ref resolution over nothing: every ref is compared as written. */
export const NO_REFS: RefResolver = { resolve: () => undefined };
