// REQ-CORE-013 (ADR-045) — the identity rules reconciliation applies, as pure functions over the contract tables, so
// the reconciler, the synthetic estate's checks and (through schemas/ci-identity.json) the Go simulator judge a merge
// the same way:
// - the full identity tuple of a type always identifies;
// - a `*Ref` value is resolved to the id of the CI it names, and the tuple with its refs resolved (the ref key)
//   identifies too, so two observers that name one host differently still describe one listener;
// - a globally unique key identifies on its own, together with its issuer's scope keys where GLOBAL_IDENTITY_SCOPES
//   lists them.
import {
  CI_IDENTITY_KEYS,
  GLOBAL_IDENTITY_KEYS,
  GLOBAL_IDENTITY_SCOPES,
  IDENTITY_REF_ALIAS_ATTRIBUTES,
  IDENTITY_REF_DERIVED,
  IDENTITY_REF_TARGETS,
  PARENT_IDENTITY_KEYS,
  type CiType,
} from './ci.js';

export interface IdentityOf {
  type: CiType;
  identity: Record<string, string>;
}

/** What a ref can name a CI by: its identity, its name and its alias attributes. */
export interface RefTargetOf extends IdentityOf {
  name: string;
  attributes: Record<string, unknown>;
}

const TUPLE = 'tuple';
const REF = 'ref';
const KEY_SEPARATOR = '|';
/** Marks a resolved ref inside a ref key: `@<ci id>`. */
export const REF_ID_PREFIX = '@';
/** Rank of a ref token: a value from the CI's identity outranks its name or an attribute. */
export const REF_TIER = { identity: 0, alias: 1 } as const;
export type RefTier = (typeof REF_TIER)[keyof typeof REF_TIER];

export function normIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** Canonical tuple of all present identity values in contract precedence order; the stored identityKey. */
export function identityTuple(type: CiType, identity: Record<string, string>): string {
  return CI_IDENTITY_KEYS[type]
    .map((k) => identity[k])
    .filter(present)
    .map(normIdentity)
    .join(KEY_SEPARATOR);
}

export function tupleKey(type: CiType, identity: Record<string, string>): string {
  return type + KEY_SEPARATOR + TUPLE + '=' + identityTuple(type, identity);
}

/** Whether a key is globally unique in a type: listed in GLOBAL_IDENTITY_KEYS and not the type's parent key. */
export function isGlobalKey(type: CiType, key: string): boolean {
  return GLOBAL_IDENTITY_KEYS.has(key) && !(PARENT_IDENTITY_KEYS[type]?.includes(key) ?? false);
}

/** CI types some `*Ref` can name; only these carry ref tokens. */
export const REF_TARGET_TYPES: ReadonlySet<CiType> = new Set(Object.values(IDENTITY_REF_TARGETS).flat());

const refKeysByType = new Map<CiType, readonly string[]>();

/** The identity keys of a type that name another CI. */
export function refKeysOfType(type: CiType): readonly string[] {
  let keys = refKeysByType.get(type);
  if (keys === undefined) {
    keys = CI_IDENTITY_KEYS[type].filter((k) => (IDENTITY_REF_TARGETS[k]?.length ?? 0) > 0);
    refKeysByType.set(type, keys);
  }
  return keys;
}

/** The (ref key, value) pairs an observation carries that name another CI. */
export function refPairs(ci: IdentityOf): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const key of refKeysOfType(ci.type)) {
    const value = ci.identity[key];
    if (present(value)) out.push({ key, value });
  }
  return out;
}

/** A globally unique match: its lookup key and the identity values a stored CI must contain to share it. */
export interface GlobalMatch {
  key: string;
  values: Record<string, string>;
}

/**
 * Every globally unique key an observation offers. A scoped key (ADR-045) carries the scope keys its type declares, and
 * is left out when the observation lacks one of them.
 */
export function globalMatches(ci: IdentityOf): GlobalMatch[] {
  const declared = CI_IDENTITY_KEYS[ci.type];
  const out: GlobalMatch[] = [];
  for (const key of declared) {
    const value = ci.identity[key];
    if (!present(value) || !isGlobalKey(ci.type, key)) continue;
    const scope = (GLOBAL_IDENTITY_SCOPES[key] ?? []).filter((s) => declared.includes(s));
    if (scope.some((s) => !present(ci.identity[s]))) continue;
    const values: Record<string, string> = {};
    for (const s of scope) values[s] = ci.identity[s] ?? '';
    values[key] = value;
    out.push({ key: ci.type + KEY_SEPARATOR + [...scope, key].map((k) => k + '=' + normIdentity(values[k] ?? '')).join(KEY_SEPARATOR), values });
  }
  return out;
}

export interface RefToken {
  token: string;
  tier: RefTier;
}

/**
 * Every spelling under which a `*Ref` may name this CI, normalised, with its rank: identity values (globally unique keys,
 * the full tuple, the derived `serial:<serial>` and `name@version` forms), then the name, the alias attributes and the
 * CI's own ref values (a hypervisor is named by its host's FQDN). Types no ref can name have none.
 */
export function refTokensOf(ci: RefTargetOf): RefToken[] {
  if (!REF_TARGET_TYPES.has(ci.type)) return [];
  const out = new Map<string, RefTier>();
  const put = (value: unknown, tier: RefTier): void => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const token = normIdentity(value);
    const prev = out.get(token);
    if (prev === undefined || tier < prev) out.set(token, tier);
  };
  const keys = CI_IDENTITY_KEYS[ci.type];
  for (const k of keys) if (isGlobalKey(ci.type, k)) put(ci.identity[k], REF_TIER.identity);
  put(identityTuple(ci.type, ci.identity), REF_TIER.identity);
  for (const d of IDENTITY_REF_DERIVED) {
    const values = d.keys.map((k) => ci.identity[k]);
    if (values.every(present)) put(d.prefix + values.join(d.separator), REF_TIER.identity);
  }
  put(ci.name, REF_TIER.alias);
  for (const a of IDENTITY_REF_ALIAS_ATTRIBUTES) {
    const value = ci.attributes[a];
    if (Array.isArray(value)) for (const v of value) put(v, REF_TIER.alias);
    else put(value, REF_TIER.alias);
  }
  for (const k of keys) if (k in IDENTITY_REF_TARGETS) put(ci.identity[k], REF_TIER.alias);
  return [...out.entries()].map(([token, tier]) => ({ token, tier }));
}

export interface RefResolver {
  /** The id of the one CI a ref value names, or undefined when none or several do. */
  resolve(refKey: string, value: string): string | undefined;
}

/**
 * In-memory ref resolution over a set of CIs. A value resolves when exactly one CI of the ref's target types carries it
 * at the best rank present: deterministic for a given set of CIs, whatever order they were added in.
 */
export class MapRefIndex implements RefResolver {
  private readonly byToken = new Map<string, Map<string, { type: CiType; tier: RefTier }>>();

  add(ci: RefTargetOf, ciId: string): void {
    for (const { token, tier } of refTokensOf(ci)) {
      let entries = this.byToken.get(token);
      if (entries === undefined) {
        entries = new Map();
        this.byToken.set(token, entries);
      }
      const prev = entries.get(ciId);
      if (prev === undefined || tier < prev.tier) entries.set(ciId, { type: ci.type, tier });
    }
  }

  resolve(refKey: string, value: string): string | undefined {
    const targets = IDENTITY_REF_TARGETS[refKey];
    if (targets === undefined || targets.length === 0) return undefined;
    const entries = this.byToken.get(normIdentity(value));
    if (entries === undefined) return undefined;
    let best: number = Number.POSITIVE_INFINITY;
    let ids: string[] = [];
    for (const [id, e] of entries) {
      if (!targets.includes(e.type)) continue;
      if (e.tier < best) {
        best = e.tier;
        ids = [id];
      } else if (e.tier === best) ids.push(id);
    }
    return ids.length === 1 ? ids[0] : undefined;
  }
}

/**
 * The tuple with each ref replaced by the id it resolves to (`type|ref=@<id>|tcp|443`). Null when the observation
 * carries no ref that names a CI, or when one of its refs does not resolve yet.
 */
export function refKeyOf(ci: IdentityOf, refs: RefResolver): string | null {
  const refKeys = refKeysOfType(ci.type);
  if (refKeys.length === 0) return null;
  let resolved = false;
  const parts: string[] = [];
  for (const k of CI_IDENTITY_KEYS[ci.type]) {
    const v = ci.identity[k];
    if (!present(v)) continue;
    if (refKeys.includes(k)) {
      const id = refs.resolve(k, v);
      if (id === undefined) return null;
      parts.push(REF_ID_PREFIX + id);
      resolved = true;
    } else parts.push(normIdentity(v));
  }
  return resolved ? ci.type + KEY_SEPARATOR + REF + '=' + parts.join(KEY_SEPARATOR) : null;
}

/** Every lookup key an observation offers: the tuple, the ref key when its refs resolve, then each global key. */
export function identityKeysOf(ci: IdentityOf, refKey: string | null = null): string[] {
  const out: string[] = [];
  if (identityTuple(ci.type, ci.identity) !== '') out.push(tupleKey(ci.type, ci.identity));
  if (refKey !== null) out.push(refKey);
  for (const g of globalMatches(ci)) out.push(g.key);
  return out;
}

const depthByType = new Map<CiType, number>();

/**
 * How many ref hops separate a type from CIs that name nothing: a host is 0, a hypervisor (hostRef) 1, a VM
 * (hypervisorRef) 2. Reconciling a result in this order lets a ref name a CI the same result creates. Cycles count once.
 */
export function refDepth(type: CiType, visiting: ReadonlySet<CiType> = new Set()): number {
  const known = depthByType.get(type);
  if (known !== undefined) return known;
  const seen = new Set(visiting).add(type);
  let depth = 0;
  for (const k of refKeysOfType(type)) {
    for (const target of IDENTITY_REF_TARGETS[k] ?? []) {
      if (seen.has(target)) continue;
      depth = Math.max(depth, refDepth(target, seen) + 1);
    }
  }
  if (visiting.size === 0) depthByType.set(type, depth);
  return depth;
}
