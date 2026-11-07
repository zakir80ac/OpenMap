// REQ-CORE-013 — Prisma-backed lookup for one collector result: fetches every stored CI whose
// identity tuple or any globally unique identity value appears in the result, through the
// (tenantId, type, identityKey) index and the jsonb_path_ops GIN index, then answers resolve() from memory.
// ADR-045: `*Ref` values are first resolved against the CIs they may name (GIN index on refTokens), so candidates are
// also fetched by ref key, the tuple with its refs resolved, through the (tenantId, refKey) index.
import { RECONCILER } from '@openmap/constants';
import { Prisma, type PrismaClient } from '@openmap/db';
import { IDENTITY_REF_TARGETS, normIdentity, refPairs, type Ci, type CiType, type CollectorResult, type ObservedCi, type Relationship } from '@openmap/contracts';
import { globalPairs, identityTuple, MapIdentityIndex, MapRefIndex, refKeyOf } from '../core/identity.js';
import type { StoredLookup } from '../core/reconcile.js';

export type CiRow = Prisma.CiGetPayload<Record<string, never>>;
type RelRow = Prisma.RelationshipGetPayload<Record<string, never>>;

export const identityKeyOf = identityTuple;

export function rowToCi(row: CiRow): Ci {
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    identity: row.identity as Record<string, string>,
    name: row.name,
    displayName: row.displayName,
    code: row.code ?? '',
    layer: row.layer,
    userLabel: (row.userLabel as Ci['userLabel']) ?? null,
    lifecycle: row.lifecycle,
    attributes: row.attributes as Ci['attributes'],
    tags: row.tags,
    externalIds: [],
    source: { collectorId: row.sourceCollectorId, nodeId: row.sourceNodeId, runId: row.sourceRunId, confidence: row.sourceConfidence },
    observedAt: row.observedAt.toISOString(),
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo ? row.validTo.toISOString() : null,
    checksum: row.checksum,
  };
}

export function rowToRelationship(row: RelRow): Relationship {
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    fromCiId: row.fromCiId,
    toCiId: row.toCiId,
    attributes: row.attributes as Relationship['attributes'],
    source: { collectorId: row.sourceCollectorId, nodeId: row.sourceNodeId, runId: row.sourceRunId, confidence: row.sourceConfidence },
    observedAt: row.observedAt.toISOString(),
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo ? row.validTo.toISOString() : null,
  };
}

function chunked<T>(list: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < list.length; i += RECONCILER.lookupBatchSize) chunks.push(list.slice(i, i + RECONCILER.lookupBatchSize));
  return chunks;
}

/**
 * Runs one query per chunk with at most RECONCILER.lookupConcurrency in flight. A relationship-only result of a
 * full-scale sweep names tens of thousands of endpoints; one statement per chunk all at once opened more connections
 * than the pool and the host's port forwarding could take (P1001 on the scale-1 replay).
 */
async function perChunk<T, R>(chunks: readonly T[][], query: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[][] = new Array<R[]>(chunks.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let i = next++; i < chunks.length; i = next++) out[i] = await query(chunks[i] ?? []);
  };
  await Promise.all(Array.from({ length: Math.min(RECONCILER.lookupConcurrency, chunks.length) }, lane));
  return out.flat();
}

/**
 * ADR-045: the stored CIs any `*Ref` value of these identities may name. One GIN probe on refTokens per chunk of
 * distinct values, restricted to the refs' target types.
 */
export async function fetchRefTargets(prisma: PrismaClient, tenantId: string, refs: readonly Pick<ObservedCi, 'type' | 'identity'>[]): Promise<CiRow[]> {
  const values = new Set<string>();
  const types = new Set<CiType>();
  for (const r of refs) {
    for (const { key, value } of refPairs(r)) {
      values.add(normIdentity(value));
      for (const t of IDENTITY_REF_TARGETS[key] ?? []) types.add(t);
    }
  }
  if (values.size === 0 || types.size === 0) return [];
  const typeList = [...types];
  return perChunk(chunked([...values]), (chunk) =>
    prisma.$queryRaw<CiRow[]>(Prisma.sql`
      SELECT * FROM cis
      WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND type::text = ANY(${typeList}::text[]) AND "refTokens" && ${chunk}::text[]`),
  );
}

/**
 * Candidate rows: identityKey tuple matches, ref key matches, and jsonb containment on globally unique values (with
 * their issuer scope, both spellings).
 */
async function fetchCandidates(prisma: PrismaClient, tenantId: string, refs: readonly Pick<ObservedCi, 'type' | 'identity'>[], refKeys: ReadonlySet<string>): Promise<CiRow[]> {
  const tuples = new Set<string>();
  const containments = new Set<string>();
  for (const r of refs) {
    const t = identityTuple(r.type, r.identity);
    if (t !== '') tuples.add(t);
    for (const values of globalPairs(r)) {
      containments.add(JSON.stringify(values));
      const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.toLowerCase()]));
      containments.add(JSON.stringify(lower));
    }
  }
  if (tuples.size === 0 && containments.size === 0 && refKeys.size === 0) return [];
  const rows = new Map<string, CiRow>();
  const collect = (batch: CiRow[]): void => {
    for (const row of batch) rows.set(row.id, row);
  };
  if (tuples.size > 0) {
    // Btree probe through cis_tenantId_identityKey_idx; "= ANY" is index-searchable.
    const tupleList = [...tuples];
    collect(await prisma.$queryRaw<CiRow[]>(Prisma.sql`
      SELECT * FROM cis
      WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND "identityKey" = ANY(${tupleList}::text[])`));
  }
  if (refKeys.size > 0) {
    // Btree probe through cis_tenantId_refKey_idx.
    const refKeyList = [...refKeys];
    collect(await prisma.$queryRaw<CiRow[]>(Prisma.sql`
      SELECT * FROM cis
      WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND "refKey" = ANY(${refKeyList}::text[])`));
  }
  // GIN cannot serve "@> ANY(array)", so containment terms become an OR chain the planner turns into
  // a BitmapOr of index probes; chunked so one statement never carries thousands of terms.
  // Chunks are independent; a bounded number run concurrently.
  collect(
    await perChunk(chunked([...containments]), (chunk) => {
      const terms = Prisma.join(chunk.map((j) => Prisma.sql`identity @> ${j}::jsonb`), ' OR ');
      return prisma.$queryRaw<CiRow[]>(Prisma.sql`
        SELECT * FROM cis
        WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND (${terms})`);
    }),
  );
  return [...rows.values()];
}

/** The identities a result names: its CIs, its relationship ends and its samples' CIs. */
function identitiesOf(result: CollectorResult): Array<Pick<ObservedCi, 'type' | 'identity'>> {
  const refs: Array<Pick<ObservedCi, 'type' | 'identity'>> = [...result.cis];
  for (const r of result.relationships) {
    if ('type' in r.from) refs.push(r.from);
    if ('type' in r.to) refs.push(r.to);
  }
  for (const s of result.samples) if ('type' in s.ci) refs.push(s.ci);
  return refs;
}

/** Loads current CIs matching any identity in the result, the CIs its refs may name, and current relationships among them. */
export async function loadLookup(prisma: PrismaClient, result: CollectorResult): Promise<StoredLookup & { cis: Map<string, Ci> }> {
  const refs = identitiesOf(result);
  const cis = new Map<string, Ci>();
  const storedRefKeys = new Map<string, string | null>();
  const refIndex = new MapRefIndex();
  const addRow = (row: CiRow): void => {
    if (cis.has(row.id)) return;
    const ci = rowToCi(row);
    cis.set(ci.id, ci);
    storedRefKeys.set(ci.id, row.refKey);
    refIndex.add(ci, ci.id);
  };
  for (const row of await fetchRefTargets(prisma, result.tenantId, refs)) addRow(row);
  const refKeys = new Set<string>();
  for (const r of refs) {
    if (refPairs(r).length === 0) continue;
    const k = refKeyOf(r, refIndex);
    if (k !== null) refKeys.add(k);
  }
  for (const row of await fetchCandidates(prisma, result.tenantId, refs, refKeys)) addRow(row);
  const index = new MapIdentityIndex();
  for (const ci of cis.values()) index.add(ci, ci.id, storedRefKeys.get(ci.id) ?? null);
  const ids = [...cis.keys()];
  // One array parameter: a full-scale result names more CIs than Postgres allows bind variables (32,767) in an IN list.
  const relRows = ids.length
    ? await prisma.$queryRaw<RelRow[]>(Prisma.sql`
        SELECT * FROM relationships WHERE "tenantId" = ${result.tenantId}::uuid AND "validTo" IS NULL AND "fromCiId" = ANY(${ids}::uuid[])`)
    : [];
  const rels = new Map<string, Relationship>();
  for (const row of relRows) {
    const r = rowToRelationship(row);
    rels.set(r.type + '|' + r.fromCiId + '|' + r.toCiId, r);
  }
  return {
    index,
    refs: refIndex,
    cis,
    getCi: (id) => cis.get(id),
    storedRefKey: (id) => (storedRefKeys.has(id) ? (storedRefKeys.get(id) ?? null) : undefined),
    findRelationship: (type, fromCiId, toCiId) => rels.get(type + '|' + fromCiId + '|' + toCiId),
  };
}
