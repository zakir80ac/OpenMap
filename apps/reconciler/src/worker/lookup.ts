// REQ-CORE-013 — Prisma-backed lookup for one collector result: fetches every stored CI whose
// identity tuple or any globally unique identity value appears in the result, through the
// (tenantId, type, identityKey) index and the jsonb_path_ops GIN index, then answers resolve() from memory.
import { RECONCILER } from '@openmap/constants';
import { Prisma, type PrismaClient } from '@openmap/db';
import type { Ci, CollectorResult, ObservedCi, Relationship } from '@openmap/contracts';
import { globalPairs, identityTuple, MapIdentityIndex } from '../core/identity.js';
import type { StoredLookup } from '../core/reconcile.js';

type CiRow = Prisma.CiGetPayload<Record<string, never>>;
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

/** Candidate rows: identityKey tuple matches plus jsonb containment on globally unique values (both spellings). */
async function fetchCandidates(prisma: PrismaClient, tenantId: string, refs: readonly Pick<ObservedCi, 'type' | 'identity'>[]): Promise<CiRow[]> {
  const tuples = new Set<string>();
  const containments = new Set<string>();
  for (const r of refs) {
    const t = identityTuple(r.type, r.identity);
    if (t !== '') tuples.add(t);
    for (const { key, value } of globalPairs(r)) {
      containments.add(JSON.stringify({ [key]: value }));
      const lower = value.toLowerCase();
      if (lower !== value) containments.add(JSON.stringify({ [key]: lower }));
    }
  }
  if (tuples.size === 0 && containments.size === 0) return [];
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
  // GIN cannot serve "@> ANY(array)", so containment terms become an OR chain the planner turns into
  // a BitmapOr of index probes; chunked so one statement never carries thousands of terms.
  const jsonList = [...containments];
  const chunks: string[][] = [];
  for (let i = 0; i < jsonList.length; i += RECONCILER.lookupBatchSize) chunks.push(jsonList.slice(i, i + RECONCILER.lookupBatchSize));
  // Chunks are independent; the pool runs them concurrently.
  const batches = await Promise.all(
    chunks.map((chunk) => {
      const terms = Prisma.join(chunk.map((j) => Prisma.sql`identity @> ${j}::jsonb`), ' OR ');
      return prisma.$queryRaw<CiRow[]>(Prisma.sql`
        SELECT * FROM cis
        WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND (${terms})`);
    }),
  );
  for (const batch of batches) collect(batch);
  return [...rows.values()];
}

/** Loads current CIs matching any identity in the result, plus current relationships among them. */
export async function loadLookup(prisma: PrismaClient, result: CollectorResult): Promise<StoredLookup & { cis: Map<string, Ci> }> {
  const refs: Array<Pick<ObservedCi, 'type' | 'identity'>> = [...result.cis];
  for (const r of result.relationships) {
    if ('type' in r.from) refs.push(r.from);
    if ('type' in r.to) refs.push(r.to);
  }
  const cis = new Map<string, Ci>();
  const index = new MapIdentityIndex();
  for (const row of await fetchCandidates(prisma, result.tenantId, refs)) {
    const ci = rowToCi(row);
    cis.set(ci.id, ci);
    index.add(ci, ci.id);
  }
  const ids = [...cis.keys()];
  const relRows = ids.length ? await prisma.relationship.findMany({ where: { tenantId: result.tenantId, validTo: null, fromCiId: { in: ids } } }) : [];
  const rels = new Map<string, Relationship>();
  for (const row of relRows) {
    const r = rowToRelationship(row);
    rels.set(r.type + '|' + r.fromCiId + '|' + r.toCiId, r);
  }
  return {
    index,
    cis,
    getCi: (id) => cis.get(id),
    findRelationship: (type, fromCiId, toCiId) => rels.get(type + '|' + fromCiId + '|' + toCiId),
  };
}
