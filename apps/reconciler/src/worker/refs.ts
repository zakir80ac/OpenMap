// REQ-CORE-013 (ADR-045) — the `*Ref` side of reconciliation that runs outside one result:
// - ref tokens for CIs that have none (written before migration 0028, or by a writer other than the reconciler);
// - pending refs: a CI whose ref named no single known CI is retried, round robin, once the CI it names may exist;
// - folding: CIs that share a ref key are one CI seen by observers that name its parent differently (a load balancer's
//   pool member by IP, the host's agent by UUID). The oldest survives; the others' identity, attributes, tags,
//   relationships, parts, external ids and asset record move to it, and they are retired.
// Every step is idempotent and keyed by what the store holds, so the outcome does not depend on result order.
import { randomUUID } from 'node:crypto';
import { RECONCILER } from '@openmap/constants';
import { REF_TARGET_TYPES, refKeyOf, refPairs, refTokensOf, type Ci, type EventEnvelope, type Relationship } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { envelope } from '../core/events.js';
import { MapRefIndex } from '../core/identity.js';
import { checksum, merge } from '../core/merge.js';
import { fetchRefTargets, rowToCi, rowToRelationship, type CiRow } from './lookup.js';
import { asReconciler, insertOutboxBatch, insertRelationshipsBatch, updateCisBatch, updateRefKeys, type RefKeyEntry } from './persist.js';

/** The actor recorded on relationships folding retires. */
const FOLD_ACTOR = 'reconciler:ref-fold';
const TRACER = 'openmap-reconciler';

export interface RefPassSummary {
  /** CIs whose ref tokens were computed. */
  tokens: number;
  /** Pending CIs retried, and how many of them now resolve. */
  tried: number;
  resolved: number;
  /** CIs folded into another CI with the same ref key. */
  folded: number;
}

/** Computes the ref tokens of CIs a ref can name that have none yet. */
export async function backfillRefTokens(prisma: PrismaClient, tenantId: string): Promise<number> {
  const types = [...REF_TARGET_TYPES];
  const rows = await prisma.$queryRaw<CiRow[]>(Prisma.sql`
    SELECT * FROM cis
    WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND cardinality("refTokens") = 0 AND type::text = ANY(${types}::text[])
    LIMIT ${RECONCILER.refTokenBackfillBatch}`);
  if (rows.length === 0) return 0;
  const cis = rows.map(rowToCi);
  await prisma.$transaction(async (tx) => {
    await asReconciler(tx);
    await tx.$executeRaw(Prisma.sql`
      UPDATE cis AS c SET "refTokens" = ARRAY(SELECT jsonb_array_elements_text(u.tokens::jsonb))
      FROM unnest(${cis.map((c) => c.id)}::uuid[], ${cis.map((c) => JSON.stringify(refTokensOf(c).map((t) => t.token)))}::text[]) AS u(id, tokens)
      WHERE c.id = u.id`);
  });
  return rows.length;
}

/**
 * Retries pending refs, oldest check first; resolved CIs get their ref key and copies sharing it are folded. A pending CI
 * without refs (written by another writer, or current when migration 0028 ran) simply leaves the pending set.
 */
export async function resolvePendingRefs(prisma: PrismaClient, tenantId: string): Promise<Omit<RefPassSummary, 'tokens'>> {
  const rows = await prisma.$queryRaw<CiRow[]>(Prisma.sql`
    SELECT * FROM cis
    WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND "refsPending"
    ORDER BY "refsCheckedAt" ASC NULLS FIRST, id
    LIMIT ${RECONCILER.pendingRefBatch}`);
  if (rows.length === 0) return { tried: 0, resolved: 0, folded: 0 };
  const cis = rows.map(rowToCi);
  const refs = new MapRefIndex();
  for (const row of await fetchRefTargets(prisma, tenantId, cis)) refs.add(rowToCi(row), row.id);
  const resolved: Array<{ ciId: string; refKey: string }> = [];
  const settled: RefKeyEntry[] = [];
  const unresolved: string[] = [];
  for (const ci of cis) {
    if (refPairs(ci).length === 0) {
      settled.push({ ciId: ci.id, refKey: null, pending: false });
      continue;
    }
    const refKey = refKeyOf(ci, refs);
    if (refKey === null) unresolved.push(ci.id);
    else resolved.push({ ciId: ci.id, refKey });
  }
  await prisma.$transaction(async (tx) => {
    await asReconciler(tx);
    await updateRefKeys(tx, [...settled, ...resolved.map((r) => ({ ...r, pending: false }))]);
    if (unresolved.length > 0) await tx.$executeRaw(Prisma.sql`UPDATE cis SET "refsCheckedAt" = now() WHERE id = ANY(${unresolved}::uuid[])`);
  });
  const folded = await foldRefDuplicates(prisma, tenantId, resolved.map((r) => r.refKey));
  return { tried: rows.length, resolved: resolved.length + settled.length, folded };
}

/** One pass: tokens first, so a pending ref can name a CI whose tokens were missing. */
export async function runRefPass(prisma: PrismaClient, tenantId: string): Promise<RefPassSummary> {
  return withSpan(TRACER, 'reconcile.identity_refs', { 'openmap.tenant_id': tenantId }, async (span) => {
    const tokens = await backfillRefTokens(prisma, tenantId);
    const pending = await resolvePendingRefs(prisma, tenantId);
    span.setAttributes({ 'openmap.refs.tokens': tokens, 'openmap.refs.tried': pending.tried, 'openmap.refs.resolved': pending.resolved, 'openmap.refs.folded': pending.folded });
    return { tokens, ...pending };
  });
}

function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** The survivor with each copy's identity, attributes and tags folded in, in survivor-first order. */
export function foldInto(survivor: Ci, copies: readonly Ci[]): { ci: Ci; changedKeys: string[] } {
  let ci = survivor;
  const changed = new Set<string>();
  for (const copy of copies) {
    const merged = merge({ attributes: ci.attributes, source: ci.source, observedAt: ci.observedAt }, { attributes: copy.attributes, source: copy.source, observedAt: copy.observedAt });
    for (const k of merged.changedKeys) changed.add(k);
    const identity = { ...copy.identity, ...ci.identity };
    ci = {
      ...ci,
      identity,
      attributes: merged.attributes,
      source: merged.source,
      observedAt: later(ci.observedAt, copy.observedAt),
      tags: [...new Set([...ci.tags, ...copy.tags])],
      checksum: checksum(ci.type, identity, merged.attributes),
    };
  }
  return { ci, changedKeys: [...changed] };
}

/**
 * Re-points relationships that touch a folded copy at its survivor. Each copy's relationship is retired; one with the
 * survivor's edge already present, or that would link the survivor to itself, is not recreated.
 */
export function repointRelationships(rels: readonly Relationship[], survivorOf: ReadonlyMap<string, string>, validTo: string): { retired: Relationship[]; created: Relationship[] } {
  const edge = (type: string, from: string, to: string): string => type + '|' + from + '|' + to;
  const present = new Set<string>();
  for (const r of rels) if (!survivorOf.has(r.fromCiId) && !survivorOf.has(r.toCiId)) present.add(edge(r.type, r.fromCiId, r.toCiId));
  const retired: Relationship[] = [];
  const created: Relationship[] = [];
  for (const r of rels) {
    if (!survivorOf.has(r.fromCiId) && !survivorOf.has(r.toCiId)) continue;
    retired.push({ ...r, validTo });
    const fromCiId = survivorOf.get(r.fromCiId) ?? r.fromCiId;
    const toCiId = survivorOf.get(r.toCiId) ?? r.toCiId;
    const k = edge(r.type, fromCiId, toCiId);
    if (fromCiId === toCiId || present.has(k)) continue;
    present.add(k);
    created.push({ ...r, id: randomUUID(), fromCiId, toCiId });
  }
  return { retired, created };
}

/** Folds every group of current CIs that share one of these ref keys into its oldest member. Returns the CIs retired. */
export async function foldRefDuplicates(prisma: PrismaClient, tenantId: string, refKeys: readonly string[]): Promise<number> {
  const keys = [...new Set(refKeys)];
  if (keys.length === 0) return 0;
  const groups = await prisma.$queryRaw<Array<{ refKey: string; ids: string[] }>>(Prisma.sql`
    SELECT "refKey", array_agg(id::text ORDER BY "validFrom", id) AS ids FROM cis
    WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND "refKey" = ANY(${keys}::text[])
    GROUP BY "refKey" HAVING count(*) > 1`);
  if (groups.length === 0) return 0;
  const allIds = groups.flatMap((g) => g.ids);
  const rows = await prisma.ci.findMany({ where: { id: { in: allIds } } });
  const byId = new Map(rows.map((r) => [r.id, { ci: rowToCi(r), refKey: r.refKey }]));
  const survivorOf = new Map<string, string>();
  const updated: Ci[] = [];
  const retiredCis: Ci[] = [];
  const refKeyOfSurvivor = new Map<string, string | null>();
  const events: EventEnvelope[] = [];
  const validTo = new Date().toISOString();
  for (const g of groups) {
    const [first, ...rest] = g.ids;
    const survivor = first === undefined ? undefined : byId.get(first);
    if (survivor === undefined) continue;
    const copies = rest.map((id) => byId.get(id)?.ci).filter((c): c is Ci => c !== undefined);
    const { ci, changedKeys } = foldInto(survivor.ci, copies);
    refKeyOfSurvivor.set(ci.id, survivor.refKey);
    if (ci.checksum !== survivor.ci.checksum || ci.tags.length !== survivor.ci.tags.length) {
      updated.push(ci);
      events.push(envelope(tenantId, 'openmap.ci.updated', ci.id, { ci, changedKeys }));
    }
    for (const copy of copies) {
      survivorOf.set(copy.id, ci.id);
      const retired = { ...copy, validTo };
      retiredCis.push(retired);
      events.push(envelope(tenantId, 'openmap.ci.retired', copy.id, { ci: retired, mergedInto: ci.id }));
    }
  }
  if (retiredCis.length === 0) return 0;
  const relRows = await prisma.relationship.findMany({ where: { tenantId, validTo: null, OR: [{ fromCiId: { in: allIds } }, { toCiId: { in: allIds } }] } });
  const { retired: retiredRels, created: createdRels } = repointRelationships(relRows.map(rowToRelationship), survivorOf, validTo);
  for (const r of retiredRels) events.push(envelope(tenantId, 'openmap.relationship.retired', r.id, { relationship: r, relationshipId: r.id, validTo, by: FOLD_ACTOR }));
  for (const r of createdRels) events.push(envelope(tenantId, 'openmap.relationship.created', r.id, { relationship: r }));
  const copyIds = [...survivorOf.keys()];
  const survivorIds = copyIds.map((id) => survivorOf.get(id) ?? id);
  // Dependents whose ref key names a retired copy resolve again, to its survivor.
  const namesCopy = '@(' + copyIds.join('|') + ')([|]|$)';
  await prisma.$transaction(
    async (tx) => {
      await asReconciler(tx);
      await updateCisBatch(tx, updated, refKeyOfSurvivor);
      await tx.$executeRaw(Prisma.sql`UPDATE cis SET "validTo" = ${validTo}::timestamptz, "refsPending" = false, "updatedAt" = now() WHERE id = ANY(${copyIds}::uuid[])`);
      if (retiredRels.length > 0) await tx.$executeRaw(Prisma.sql`UPDATE relationships SET "validTo" = ${validTo}::timestamptz, "updatedAt" = now() WHERE id = ANY(${retiredRels.map((r) => r.id)}::uuid[])`);
      await insertRelationshipsBatch(tx, createdRels);
      await tx.$executeRaw(Prisma.sql`
        UPDATE ci_components AS c SET "ciId" = m.survivor
        FROM unnest(${copyIds}::uuid[], ${survivorIds}::uuid[]) AS m(copy, survivor)
        WHERE c."ciId" = m.copy AND NOT EXISTS (SELECT 1 FROM ci_components s WHERE s."ciId" = m.survivor AND s.kind = c.kind AND s.slot = c.slot)`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE ci_external_ids AS x SET "ciId" = m.survivor, "updatedAt" = now()
        FROM unnest(${copyIds}::uuid[], ${survivorIds}::uuid[]) AS m(copy, survivor)
        WHERE x."ciId" = m.copy AND NOT EXISTS (SELECT 1 FROM ci_external_ids s WHERE s."ciId" = m.survivor AND s.source = x.source AND s."externalId" = x."externalId")`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE asset_records AS a SET "ciId" = m.survivor, "updatedAt" = now()
        FROM unnest(${copyIds}::uuid[], ${survivorIds}::uuid[]) AS m(copy, survivor)
        WHERE a."ciId" = m.copy AND NOT EXISTS (SELECT 1 FROM asset_records s WHERE s."ciId" = m.survivor)`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE cis SET "refKey" = NULL, "refsPending" = true, "refsCheckedAt" = NULL
        WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND "refKey" ~ ${namesCopy}`);
      await insertOutboxBatch(tx, events);
    },
    { timeout: RECONCILER.persistTransactionTimeoutMs, maxWait: RECONCILER.persistTransactionMaxWaitMs },
  );
  return retiredCis.length;
}
