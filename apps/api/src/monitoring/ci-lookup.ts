// REQ-INT-012 (ADR-073) — which CI an alert is about. An alert names the affected thing by a CI id, an FQDN, an
// instance, an address or a short hostname (monitoringEventSchema.targets). The CI id wins when it is a current CI of
// the tenant; then an operator's mapping of any of the alert's source keys; then, target by target in contract order,
// the identity lookup the reconciler uses for `*Ref` values (ADR-045: a CI's ref tokens are its identity values, its
// name and its fqdn / hostname / address attributes, ranked identity above alias), and last the identity tokens of
// CIs the reconciler has not tokenised yet (fqdn, sysName, hostname). A value that names more than one CI at its best
// rank names none: the alert stays unresolved and is listed for mapping.
import { RECONCILER } from '@openmap/constants';
import {
  normalizeSourceKey,
  refTokensOf,
  type CiType,
  type MonitoringTarget,
  type RefTier,
} from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';

export type MonitoringResolution = 'ci_id' | 'mapping' | 'identity';

export interface ResolvedCi {
  ciId: string;
  resolution: MonitoringResolution;
}

/** Identity keys whose value is a host name; probed through the identity-token index (migration 0031). */
export const HOST_IDENTITY_KEYS = ['fqdn', 'sysName', 'hostname'] as const;

export interface LookupIndex {
  /** Current CI ids of the tenant among the ids alerts named. */
  ciIds: ReadonlySet<string>;
  /** Source key → mapped CI id. */
  mappings: ReadonlyMap<string, string>;
  /** Ref token → CI ids with the rank of the token for each. */
  refs: ReadonlyMap<string, ReadonlyMap<string, RefTier>>;
  /** Host-name value → CI ids whose identity holds it. */
  identities: ReadonlyMap<string, ReadonlySet<string>>;
}

function single(ids: Iterable<string>): string | null {
  let found: string | null = null;
  for (const id of ids) {
    if (found !== null && found !== id) return null;
    found = id;
  }
  return found;
}

/** The CIs a value names at its best rank. */
function bestRanked(entries: ReadonlyMap<string, RefTier> | undefined): string[] {
  if (entries === undefined) return [];
  let best = Number.POSITIVE_INFINITY;
  let ids: string[] = [];
  for (const [id, tier] of entries) {
    if (tier < best) {
      best = tier;
      ids = [id];
    } else if (tier === best) ids.push(id);
  }
  return ids;
}

/** Pure: the CI one alert resolves to, from the candidates fetched for the whole request. */
export function chooseCi(targets: readonly MonitoringTarget[], index: LookupIndex): ResolvedCi | null {
  for (const t of targets) if (t.kind === 'ci_id' && index.ciIds.has(t.value)) return { ciId: t.value, resolution: 'ci_id' };
  for (const t of targets) {
    if (t.kind === 'ci_id') continue;
    const mapped = index.mappings.get(normalizeSourceKey(t.value));
    if (mapped !== undefined) return { ciId: mapped, resolution: 'mapping' };
  }
  for (const t of targets) {
    if (t.kind === 'ci_id') continue;
    const key = normalizeSourceKey(t.value);
    const ranked = bestRanked(index.refs.get(key));
    if (ranked.length === 1 && ranked[0] !== undefined) return { ciId: ranked[0], resolution: 'identity' };
    if (ranked.length > 1) continue;
    const byIdentity = single(index.identities.get(key) ?? []);
    if (byIdentity !== null) return { ciId: byIdentity, resolution: 'identity' };
  }
  return null;
}

interface RefRow {
  id: string;
  type: CiType;
  name: string;
  identity: Record<string, string>;
  attributes: Record<string, unknown>;
}

interface TokenRow {
  id: string;
  identityTokens: string[];
}

/** Fetches every candidate for a request's alerts in four indexed probes. */
export async function buildLookupIndex(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  targets: readonly MonitoringTarget[],
): Promise<LookupIndex> {
  const ids = [...new Set(targets.filter((t) => t.kind === 'ci_id').map((t) => t.value))];
  const keys = [...new Set(targets.filter((t) => t.kind !== 'ci_id').map((t) => normalizeSourceKey(t.value)))].slice(0, RECONCILER.lookupBatchSize);
  const ciIds =
    ids.length === 0
      ? new Set<string>()
      : new Set((await prisma.ci.findMany({ where: { tenantId, id: { in: ids }, validTo: null }, select: { id: true } })).map((c) => c.id));
  if (keys.length === 0) return { ciIds, mappings: new Map(), refs: new Map(), identities: new Map() };
  const mappings = new Map(
    (await prisma.monitoringSourceMapping.findMany({ where: { tenantId, sourceKey: { in: keys } }, select: { sourceKey: true, ciId: true } })).map((m) => [m.sourceKey, m.ciId] as const),
  );
  const refRows = await prisma.$queryRaw<RefRow[]>(Prisma.sql`
    SELECT id, type::text AS type, name, identity, attributes FROM cis
    WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND "refTokens" && ${keys}::text[]`);
  const wanted = new Set(keys);
  const refs = new Map<string, Map<string, RefTier>>();
  for (const row of refRows) {
    for (const { token, tier } of refTokensOf(row)) {
      if (!wanted.has(token)) continue;
      const entries = refs.get(token) ?? new Map<string, RefTier>();
      const prev = entries.get(row.id);
      if (prev === undefined || tier < prev) entries.set(row.id, tier);
      refs.set(token, entries);
    }
  }
  const tokens = keys.flatMap((k) => HOST_IDENTITY_KEYS.map((name) => name + '=' + k));
  const tokenRows = await prisma.$queryRaw<TokenRow[]>(Prisma.sql`
    SELECT id, "identityTokens" FROM cis
    WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND "identityTokens" && ${tokens}::text[]`);
  const identities = new Map<string, Set<string>>();
  const tokenSet = new Set(tokens);
  for (const row of tokenRows) {
    for (const token of row.identityTokens) {
      if (!tokenSet.has(token)) continue;
      const value = token.slice(token.indexOf('=') + 1);
      const set = identities.get(value) ?? new Set<string>();
      set.add(row.id);
      identities.set(value, set);
    }
  }
  return { ciIds, mappings, refs, identities };
}
