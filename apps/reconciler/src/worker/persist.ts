// REQ-CORE-013 REQ-CORE-005 — writes a ReconcileOutput to Postgres in one transaction together
// with its outbox events. Nothing else writes CIs; every other store learns through the outbox.
// Every table is written with one array-based INSERT/UPDATE per batch (unnest of parallel arrays),
// which is what keeps a 10k-device sweep inside the 15-minute budget.
import type { Ci, EventEnvelope, Relationship } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { identityKeyOf } from './lookup.js';
import type { ReconcileOutput } from '../core/reconcile.js';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

const OUTBOX_TARGETS: Array<'memgraph' | 'clickhouse' | 'meilisearch' | 'websocket' | 'bsm'> = [
  'memgraph',
  'clickhouse',
  'meilisearch',
  'websocket',
  'bsm',
];

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

/** One round trip for every created CI. ON CONFLICT mirrors createMany's skipDuplicates. */
async function insertCisBatch(tx: Tx, cis: readonly Ci[]): Promise<void> {
  if (cis.length === 0) return;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO cis (id, "tenantId", type, identity, "identityKey", name, "displayName", code, layer, "userLabel", lifecycle, attributes, tags,
      "sourceCollectorId", "sourceNodeId", "sourceRunId", "sourceConfidence", "observedAt", "validFrom", "validTo", checksum, "updatedAt")
    SELECT u.id, u.tenant_id, u.type::"CiType", u.identity::jsonb, u.identity_key, u.name, u.display_name, u.code, u.layer::"CiLayer",
      CASE WHEN u.user_label IS NULL THEN NULL ELSE u.user_label::jsonb END, u.lifecycle::"Lifecycle", u.attributes::jsonb,
      ARRAY(SELECT jsonb_array_elements_text(u.tags::jsonb)), u.collector, u.node, u.run, u.confidence, u.observed_at::timestamptz, u.valid_from::timestamptz,
      CASE WHEN u.valid_to IS NULL THEN NULL ELSE u.valid_to::timestamptz END, u.checksum, now()
    FROM unnest(
      ${cis.map((c) => c.id)}::uuid[], ${cis.map((c) => c.tenantId)}::uuid[], ${cis.map((c) => c.type)}::text[], ${cis.map((c) => JSON.stringify(c.identity))}::text[],
      ${cis.map((c) => identityKeyOf(c.type, c.identity))}::text[], ${cis.map((c) => c.name)}::text[], ${cis.map((c) => c.displayName)}::text[], ${cis.map((c) => c.code)}::text[],
      ${cis.map((c) => c.layer)}::text[], ${cis.map((c) => (c.userLabel ? JSON.stringify(c.userLabel) : null))}::text[], ${cis.map((c) => c.lifecycle)}::text[],
      ${cis.map((c) => JSON.stringify(c.attributes))}::text[], ${cis.map((c) => JSON.stringify(c.tags))}::text[],
      ${cis.map((c) => c.source.collectorId)}::text[], ${cis.map((c) => c.source.nodeId)}::text[], ${cis.map((c) => c.source.runId)}::text[], ${cis.map((c) => c.source.confidence)}::float8[],
      ${cis.map((c) => c.observedAt)}::text[], ${cis.map((c) => c.validFrom)}::text[], ${cis.map((c) => nullable(c.validTo))}::text[], ${cis.map((c) => c.checksum)}::text[]
    ) AS u(id, tenant_id, type, identity, identity_key, name, display_name, code, layer, user_label, lifecycle, attributes, tags, collector, node, run, confidence, observed_at, valid_from, valid_to, checksum)
    ON CONFLICT (id) DO NOTHING`);
}

/** One round trip for every updated CI: unnest parallel arrays and join on id. */
async function updateCisBatch(tx: Tx, cis: readonly Ci[]): Promise<void> {
  if (cis.length === 0) return;
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
      "updatedAt" = now()
    FROM unnest(
      ${cis.map((c) => c.id)}::uuid[], ${cis.map((c) => JSON.stringify(c.identity))}::text[], ${cis.map((c) => identityKeyOf(c.type, c.identity))}::text[],
      ${cis.map((c) => JSON.stringify(c.attributes))}::text[], ${cis.map((c) => JSON.stringify(c.tags))}::text[],
      ${cis.map((c) => c.source.collectorId)}::text[], ${cis.map((c) => c.source.nodeId)}::text[], ${cis.map((c) => c.source.runId)}::text[], ${cis.map((c) => c.source.confidence)}::float8[],
      ${cis.map((c) => c.observedAt)}::text[], ${cis.map((c) => c.checksum)}::text[]
    ) AS u(id, identity, identity_key, attributes, tags, collector, node, run, confidence, observed_at, checksum)
    WHERE c.id = u.id`);
}

async function insertRelationshipsBatch(tx: Tx, rels: readonly Relationship[]): Promise<void> {
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

async function insertOutboxBatch(tx: Tx, events: readonly EventEnvelope[]): Promise<void> {
  if (events.length === 0) return;
  const pending = Prisma.sql`ARRAY[${Prisma.join(OUTBOX_TARGETS.map((t) => Prisma.sql`${t}`))}]::"OutboxTarget"[]`;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO outbox_events ("eventId", "tenantId", type, subject, envelope, pending)
    SELECT u.event_id, u.tenant_id, u.type, u.subject, u.envelope::jsonb, ${pending}
    FROM unnest(
      ${events.map((e) => e.id)}::uuid[], ${events.map((e) => e.tenantid)}::uuid[], ${events.map((e) => e.type)}::text[], ${events.map((e) => e.subject)}::text[], ${events.map((e) => JSON.stringify(e))}::text[]
    ) AS u(event_id, tenant_id, type, subject, envelope)
    ON CONFLICT ("eventId") DO NOTHING`);
}

export interface PersistSummary {
  created: number;
  updated: number;
  relationships: number;
  conflicts: number;
  events: number;
}

export async function persist(
  prisma: PrismaClient,
  tenantId: string,
  out: ReconcileOutput,
): Promise<PersistSummary> {
  return prisma.$transaction(async (tx) => {
    await insertCisBatch(tx, out.created);
    await readBackCodes(tx, out.created, out.events);
    const externalIds = out.created.flatMap((ci) =>
      ci.externalIds.map((x) => ({ tenantId, ciId: ci.id, source: x.source, externalId: x.id })),
    );
    if (externalIds.length) await tx.ciExternalId.createMany({ data: externalIds, skipDuplicates: true });
    await updateCisBatch(tx, out.updated);
    await insertRelationshipsBatch(tx, out.relationshipsCreated);
    if (out.relationshipsSeen.length)
      await tx.relationship.updateMany({
        where: { id: { in: out.relationshipsSeen } },
        data: { observedAt: new Date() },
      });
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
    await insertOutboxBatch(tx, out.events);
    return {
      created: out.created.length,
      updated: out.updated.length,
      relationships: out.relationshipsCreated.length,
      conflicts: out.conflicts.length,
      events: out.events.length,
    };
  });
}
