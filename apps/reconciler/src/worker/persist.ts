// REQ-CORE-013 REQ-CORE-005 — writes a ReconcileOutput to Postgres in one transaction together
// with its outbox events. Nothing else writes CIs; every other store learns through the outbox.
// Every table is written with one array-based INSERT/UPDATE per batch (unnest of parallel arrays),
// which is what keeps a 10k-device sweep inside the 15-minute budget.
import { RECONCILER } from '@openmap/constants';
import { refPairs, refTokensOf, type Ci, type EventEnvelope, type Relationship } from '@openmap/contracts';
import { Prisma, refreshCoveringContracts, type PrismaClient } from '@openmap/db';
import { claimReceivedAssets, insertAssetsBatch, refreshAssetsBatch, type ClaimedAsset } from './assets.js';
import { syncComponents } from './components.js';
import { envelope } from '../core/events.js';
import { identityKeyOf } from './lookup.js';
import type { ReconcileOutput } from '../core/reconcile.js';

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

type OutboxTarget = 'memgraph' | 'clickhouse' | 'meilisearch' | 'websocket' | 'bsm';

const OUTBOX_TARGETS: readonly OutboxTarget[] = ['memgraph', 'clickhouse', 'meilisearch', 'websocket', 'bsm'];
/** Metric samples (ADR-016) live only in ClickHouse: no graph node, search document or live update carries them. */
const METRIC_TARGETS: readonly OutboxTarget[] = ['clickhouse'];

export function targetsFor(type: EventEnvelope['type']): readonly OutboxTarget[] {
  return type === 'openmap.metric.sampled' ? METRIC_TARGETS : OUTBOX_TARGETS;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function nullable(value: string | null | undefined): string | null {
  return value ?? null;
}

/**
 * Postgres may suffix a code to keep it unique per tenant (migration 0010, ADR-014). The created CIs and their
 * `openmap.ci.created` events are patched with the stored codes so Memgraph and Meilisearch carry the same value.
 */
async function readBackCodes(tx: Tx, cis: Ci[], events: readonly EventEnvelope[]): Promise<void> {
  if (cis.length === 0) return;
  const rows = await tx.$queryRaw<Array<{ id: string; code: string | null }>>(
    Prisma.sql`SELECT id, code FROM cis WHERE id = ANY(${cis.map((c) => c.id)}::uuid[])`,
  );
  const stored = new Map(rows.map((r) => [r.id, r.code]));
  const created = new Map<string, EventEnvelope[]>();
  for (const event of events) {
    if (event.type !== 'openmap.ci.created') continue;
    created.set(event.subject, [...(created.get(event.subject) ?? []), event]);
  }
  for (const ci of cis) {
    const code = stored.get(ci.id);
    if (code === undefined || code === null || code === ci.code) continue;
    ci.code = code;
    for (const event of created.get(ci.id) ?? []) {
      const data = event.data as { ci?: { code?: string } };
      if (data.ci !== undefined) data.ci.code = code;
    }
  }
}

/** ADR-045: marks the transaction as the reconciler's, so the cis trigger keeps the ref tokens it writes. */
export async function asReconciler(tx: Tx): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT set_config(${RECONCILER.refTokensSetting}, ${RECONCILER.refTokensWriter}, true)`,
  );
}

/** ADR-045: the ref columns of a CI: its tokens (JSON text), its ref key, and whether a ref is still unresolved. */
function refColumns(
  cis: readonly Ci[],
  refKeys: ReadonlyMap<string, string | null>,
): { tokens: string[]; keys: Array<string | null>; pending: boolean[] } {
  const keys = cis.map((c) => refKeys.get(c.id) ?? null);
  return {
    tokens: cis.map((c) => JSON.stringify(refTokensOf(c).map((t) => t.token))),
    keys,
    pending: cis.map((c, i) => keys[i] === null && refPairs(c).length > 0),
  };
}

/** One round trip for every created CI. ON CONFLICT mirrors createMany's skipDuplicates. */
export async function insertCisBatch(
  tx: Tx,
  cis: readonly Ci[],
  refKeys: ReadonlyMap<string, string | null> = new Map(),
): Promise<void> {
  if (cis.length === 0) return;
  const refs = refColumns(cis, refKeys);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO cis (id, "tenantId", type, identity, "identityKey", name, "displayName", code, layer, "userLabel", lifecycle, attributes, tags,
      "sourceCollectorId", "sourceNodeId", "sourceRunId", "sourceConfidence", "observedAt", "validFrom", "validTo", checksum, "refTokens", "refKey", "refsPending", "updatedAt")
    SELECT u.id, u.tenant_id, u.type::"CiType", u.identity::jsonb, u.identity_key, u.name, u.display_name, u.code, u.layer::"CiLayer",
      CASE WHEN u.user_label IS NULL THEN NULL ELSE u.user_label::jsonb END, u.lifecycle::"Lifecycle", u.attributes::jsonb,
      ARRAY(SELECT jsonb_array_elements_text(u.tags::jsonb)), u.collector, u.node, u.run, u.confidence, u.observed_at::timestamptz, u.valid_from::timestamptz,
      CASE WHEN u.valid_to IS NULL THEN NULL ELSE u.valid_to::timestamptz END, u.checksum,
      ARRAY(SELECT jsonb_array_elements_text(u.ref_tokens::jsonb)), u.ref_key, u.refs_pending, now()
    FROM unnest(
      ${cis.map((c) => c.id)}::uuid[], ${cis.map((c) => c.tenantId)}::uuid[], ${cis.map((c) => c.type)}::text[], ${cis.map((c) => JSON.stringify(c.identity))}::text[],
      ${cis.map((c) => identityKeyOf(c.type, c.identity))}::text[], ${cis.map((c) => c.name)}::text[], ${cis.map((c) => c.displayName)}::text[], ${cis.map((c) => c.code)}::text[],
      ${cis.map((c) => c.layer)}::text[], ${cis.map((c) => (c.userLabel ? JSON.stringify(c.userLabel) : null))}::text[], ${cis.map((c) => c.lifecycle)}::text[],
      ${cis.map((c) => JSON.stringify(c.attributes))}::text[], ${cis.map((c) => JSON.stringify(c.tags))}::text[],
      ${cis.map((c) => c.source.collectorId)}::text[], ${cis.map((c) => c.source.nodeId)}::text[], ${cis.map((c) => c.source.runId)}::text[], ${cis.map((c) => c.source.confidence)}::float8[],
      ${cis.map((c) => c.observedAt)}::text[], ${cis.map((c) => c.validFrom)}::text[], ${cis.map((c) => nullable(c.validTo))}::text[], ${cis.map((c) => c.checksum)}::text[],
      ${refs.tokens}::text[], ${refs.keys}::text[], ${refs.pending}::boolean[]
    ) AS u(id, tenant_id, type, identity, identity_key, name, display_name, code, layer, user_label, lifecycle, attributes, tags, collector, node, run, confidence, observed_at, valid_from, valid_to, checksum, ref_tokens, ref_key, refs_pending)
    ON CONFLICT (id) DO NOTHING`);
}

/** One round trip for every updated CI: unnest parallel arrays and join on id. */
export async function updateCisBatch(
  tx: Tx,
  cis: readonly Ci[],
  refKeys: ReadonlyMap<string, string | null> = new Map(),
): Promise<void> {
  if (cis.length === 0) return;
  const refs = refColumns(cis, refKeys);
  await tx.$executeRaw(Prisma.sql`
    UPDATE cis AS c SET
      identity = u.identity::jsonb,
      "identityKey" = u.identity_key,
      attributes = u.attributes::jsonb,
      tags = ARRAY(SELECT jsonb_array_elements_text(u.tags::jsonb)),
      "sourceCollectorId" = u.collector,
      "sourceNodeId" = u.node,
      "sourceRunId" = u.run,
      "sourceConfidence" = u.confidence,
      "observedAt" = u.observed_at::timestamptz,
      checksum = u.checksum,
      "refTokens" = ARRAY(SELECT jsonb_array_elements_text(u.ref_tokens::jsonb)),
      "refKey" = u.ref_key,
      "refsPending" = u.refs_pending,
      "refsCheckedAt" = now(),
      "updatedAt" = now()
    FROM unnest(
      ${cis.map((c) => c.id)}::uuid[], ${cis.map((c) => JSON.stringify(c.identity))}::text[], ${cis.map((c) => identityKeyOf(c.type, c.identity))}::text[],
      ${cis.map((c) => JSON.stringify(c.attributes))}::text[], ${cis.map((c) => JSON.stringify(c.tags))}::text[],
      ${cis.map((c) => c.source.collectorId)}::text[], ${cis.map((c) => c.source.nodeId)}::text[], ${cis.map((c) => c.source.runId)}::text[], ${cis.map((c) => c.source.confidence)}::float8[],
      ${cis.map((c) => c.observedAt)}::text[], ${cis.map((c) => c.checksum)}::text[],
      ${refs.tokens}::text[], ${refs.keys}::text[], ${refs.pending}::boolean[]
    ) AS u(id, identity, identity_key, attributes, tags, collector, node, run, confidence, observed_at, checksum, ref_tokens, ref_key, refs_pending)
    WHERE c.id = u.id`);
}

/** ADR-045: a CI's ref key and whether a ref of it is still unresolved, as the pending pass and unchanged CIs record them. */
export interface RefKeyEntry {
  ciId: string;
  refKey: string | null;
  pending: boolean;
}

/** ADR-045: ref keys of CIs whose refs now resolve (or no longer do) without any other change. */
export async function updateRefKeys(tx: Tx, entries: readonly RefKeyEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await tx.$executeRaw(Prisma.sql`
    UPDATE cis AS c SET "refKey" = u.ref_key, "refsPending" = u.pending, "refsCheckedAt" = now()
    FROM unnest(${entries.map((e) => e.ciId)}::uuid[], ${entries.map((e) => e.refKey)}::text[], ${entries.map((e) => e.pending)}::boolean[]) AS u(id, ref_key, pending)
    WHERE c.id = u.id`);
}

export async function insertRelationshipsBatch(tx: Tx, rels: readonly Relationship[]): Promise<void> {
  if (rels.length === 0) return;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO relationships (id, "tenantId", type, "fromCiId", "toCiId", attributes, "sourceCollectorId", "sourceNodeId", "sourceRunId", "sourceConfidence", "observedAt", "validFrom", "validTo", "updatedAt")
    SELECT u.id, u.tenant_id, u.type::"RelationshipType", u.from_id, u.to_id, u.attributes::jsonb, u.collector, u.node, u.run, u.confidence, u.observed_at::timestamptz, u.valid_from::timestamptz,
      CASE WHEN u.valid_to IS NULL THEN NULL ELSE u.valid_to::timestamptz END, now()
    FROM unnest(
      ${rels.map((r) => r.id)}::uuid[], ${rels.map((r) => r.tenantId)}::uuid[], ${rels.map((r) => r.type)}::text[], ${rels.map((r) => r.fromCiId)}::uuid[], ${rels.map((r) => r.toCiId)}::uuid[],
      ${rels.map((r) => JSON.stringify(r.attributes))}::text[], ${rels.map((r) => r.source.collectorId)}::text[], ${rels.map((r) => r.source.nodeId)}::text[], ${rels.map((r) => r.source.runId)}::text[],
      ${rels.map((r) => r.source.confidence)}::float8[], ${rels.map((r) => r.observedAt)}::text[], ${rels.map((r) => r.validFrom)}::text[], ${rels.map((r) => nullable(r.validTo))}::text[]
    ) AS u(id, tenant_id, type, from_id, to_id, attributes, collector, node, run, confidence, observed_at, valid_from, valid_to)
    ON CONFLICT (id) DO NOTHING`);
}

export async function insertOutboxBatch(tx: Tx, events: readonly EventEnvelope[]): Promise<void> {
  if (events.length === 0) return;
  // One statement per distinct target list: a result's CI events and its metric events differ in where they go.
  const groups = new Map<string, EventEnvelope[]>();
  for (const e of events) {
    const key = targetsFor(e.type).join(',');
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  for (const [key, group] of groups) {
    const pending = Prisma.sql`ARRAY[${Prisma.join(key.split(',').map((t) => Prisma.sql`${t}`))}]::"OutboxTarget"[]`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO outbox_events ("eventId", "tenantId", type, subject, envelope, pending)
      SELECT u.event_id, u.tenant_id, u.type, u.subject, u.envelope::jsonb, ${pending}
      FROM unnest(
        ${group.map((e) => e.id)}::uuid[], ${group.map((e) => e.tenantid)}::uuid[], ${group.map((e) => e.type)}::text[], ${group.map((e) => e.subject)}::text[], ${group.map((e) => JSON.stringify(e))}::text[]
      ) AS u(event_id, tenant_id, type, subject, envelope)
      ON CONFLICT ("eventId") DO NOTHING`);
  }
}

export interface PersistSummary {
  created: number;
  updated: number;
  relationships: number;
  /** REQ-CORE-021: stored relationships whose attributes changed on re-observation. */
  relationshipsUpdated: number;
  conflicts: number;
  events: number;
  /** Asset register rows created for owned CIs in this result (ADR-023). */
  assets: number;
  /** Received plan units discovery linked to their new CI and moved to deployed (ADR-034). */
  claimed: number;
  /** ADR-037: parts upserted from observed part lists, and parts closed because a sweep no longer reports them. */
  componentsUpserted: number;
  componentsRemoved: number;
}

/** ADR-034: the stage change of each claimed unit, carried by the outbox like the API's. */
export function claimEvents(claimed: readonly ClaimedAsset[]): EventEnvelope[] {
  return claimed.map((c) =>
    envelope(c.tenantId, 'openmap.asset.stage.changed', c.assetId, {
      assetId: c.assetId,
      ciId: c.ciId,
      planId: c.planId,
      stage: 'deployed',
      previous: 'in_stock',
      serialNumber: c.serialNumber,
      by: c.actor,
    }),
  );
}

export async function persist(
  prisma: PrismaClient,
  tenantId: string,
  out: ReconcileOutput,
): Promise<PersistSummary> {
  return prisma.$transaction(
    async (tx) => {
      await asReconciler(tx);
      await insertCisBatch(tx, out.created, out.refKeys);
      await readBackCodes(tx, out.created, out.events);
      const externalIds = out.created.flatMap((ci) =>
        ci.externalIds.map((x) => ({ tenantId, ciId: ci.id, source: x.source, externalId: x.id })),
      );
      if (externalIds.length) await tx.ciExternalId.createMany({ data: externalIds, skipDuplicates: true });
      await updateCisBatch(tx, out.updated, out.refKeys);
      const written = new Set([...out.created, ...out.updated].map((c) => c.id));
      await updateRefKeys(
        tx,
        [...out.refKeys]
          .filter(([id]) => !written.has(id))
          .map(([ciId, refKey]) => ({ ciId, refKey, pending: refKey === null })),
      );
      const claimed = await claimReceivedAssets(tx, out.created);
      const assets = await insertAssetsBatch(tx, out.created);
      await refreshAssetsBatch(tx, out.updated);
      // ADR-037: the part lists the observations carried, mirrored into ci_components.
      const parts = await syncComponents(tx, out.components);
      await insertRelationshipsBatch(tx, out.relationshipsCreated);
      // ADR-035: a covered_by a sweep or an import created gives the covered CI's asset its support contract.
      await refreshCoveringContracts(
        tx,
        out.relationshipsCreated.filter((r) => r.type === 'covered_by').map((r) => r.fromCiId),
      );
      // One array parameter, not an IN list: a full-scale result re-observes more links than Postgres allows bind variables.
      if (out.relationshipsSeen.length)
        await tx.$executeRaw`UPDATE relationships SET "observedAt" = ${new Date()}, "updatedAt" = ${new Date()} WHERE id = ANY(${out.relationshipsSeen}::uuid[])`;
      // REQ-CORE-021: changed attributes land on the stored edge with the provenance of the run that observed them.
      for (const r of out.relationshipsUpdated) {
        await tx.$executeRaw`UPDATE relationships SET attributes = ${JSON.stringify(r.attributes)}::jsonb, "sourceCollectorId" = ${r.source.collectorId}, "sourceNodeId" = ${r.source.nodeId}, "sourceRunId" = ${r.source.runId}, "sourceConfidence" = ${r.source.confidence}, "observedAt" = ${new Date(r.observedAt)}, "updatedAt" = ${new Date()} WHERE id = ${r.id}::uuid`;
      }
      if (out.conflicts.length) {
        await tx.reconciliationConflict.createMany({
          data: out.conflicts.map((c) => ({
            tenantId,
            type: c.observed.type,
            identityKey: identityKeyOf(c.observed.type, c.observed.identity),
            field: 'identity',
            candidates: json({ ciIds: c.ciIds, observed: c.observed }),
          })),
        });
      }
      await insertOutboxBatch(tx, [...out.events, ...claimEvents(claimed), ...parts.events]);
      return {
        created: out.created.length,
        updated: out.updated.length,
        relationships: out.relationshipsCreated.length,
        relationshipsUpdated: out.relationshipsUpdated.length,
        conflicts: out.conflicts.length,
        events: out.events.length + claimed.length + parts.events.length,
        assets,
        claimed: claimed.length,
        componentsUpserted: parts.upserted,
        componentsRemoved: parts.removed,
      };
    },
    { timeout: RECONCILER.persistTransactionTimeoutMs, maxWait: RECONCILER.persistTransactionMaxWaitMs },
  );
}
