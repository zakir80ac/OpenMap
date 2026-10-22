// REQ-CORE-013 REQ-CORE-005 — writes a ReconcileOutput to Postgres in one transaction together
// with its outbox events. Nothing else writes CIs; every other store learns through the outbox.
import type { Ci, EventEnvelope, Relationship } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { identityKeyOf } from './lookup.js';
import type { ReconcileOutput } from '../core/reconcile.js';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** One round trip for every updated CI: unnest parallel arrays and join on id. */
async function updateCisBatch(tx: Tx, cis: readonly Ci[]): Promise<void> {
  if (cis.length === 0) return;
  const ids = cis.map((c) => c.id);
  const identities = cis.map((c) => JSON.stringify(c.identity));
  const identityKeys = cis.map((c) => identityKeyOf(c.type, c.identity));
  const attributes = cis.map((c) => JSON.stringify(c.attributes));
  const tags = cis.map((c) => JSON.stringify(c.tags));
  const collectors = cis.map((c) => c.source.collectorId);
  const nodes = cis.map((c) => c.source.nodeId);
  const runs = cis.map((c) => c.source.runId);
  const confidences = cis.map((c) => c.source.confidence);
  const observed = cis.map((c) => c.observedAt);
  const checksums = cis.map((c) => c.checksum);
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
      ${ids}::uuid[], ${identities}::text[], ${identityKeys}::text[], ${attributes}::text[], ${tags}::text[],
      ${collectors}::text[], ${nodes}::text[], ${runs}::text[], ${confidences}::float8[], ${observed}::text[], ${checksums}::text[]
    ) AS u(id, identity, identity_key, attributes, tags, collector, node, run, confidence, observed_at, checksum)
    WHERE c.id = u.id`);
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

const OUTBOX_TARGETS: Array<'memgraph' | 'clickhouse' | 'meilisearch' | 'websocket' | 'bsm'> = ['memgraph', 'clickhouse', 'meilisearch', 'websocket', 'bsm'];

function ciCreate(ci: Ci): Prisma.CiUncheckedCreateInput {
  return {
    id: ci.id,
    tenantId: ci.tenantId,
    type: ci.type,
    identity: json(ci.identity),
    identityKey: identityKeyOf(ci.type, ci.identity),
    name: ci.name,
    displayName: ci.displayName,
    code: ci.code,
    layer: ci.layer,
    ...(ci.userLabel ? { userLabel: json(ci.userLabel) } : {}),
    lifecycle: ci.lifecycle,
    attributes: json(ci.attributes),
    tags: ci.tags,
    sourceCollectorId: ci.source.collectorId,
    sourceNodeId: ci.source.nodeId,
    sourceRunId: ci.source.runId,
    sourceConfidence: ci.source.confidence,
    observedAt: new Date(ci.observedAt),
    validFrom: new Date(ci.validFrom),
    validTo: ci.validTo ? new Date(ci.validTo) : null,
    checksum: ci.checksum,
  };
}

function relationshipCreate(r: Relationship): Prisma.RelationshipUncheckedCreateInput {
  return {
    id: r.id,
    tenantId: r.tenantId,
    type: r.type,
    fromCiId: r.fromCiId,
    toCiId: r.toCiId,
    attributes: json(r.attributes),
    sourceCollectorId: r.source.collectorId,
    sourceNodeId: r.source.nodeId,
    sourceRunId: r.source.runId,
    sourceConfidence: r.source.confidence,
    observedAt: new Date(r.observedAt),
    validFrom: new Date(r.validFrom),
    validTo: r.validTo ? new Date(r.validTo) : null,
  };
}

function outboxCreate(e: EventEnvelope): Prisma.OutboxEventUncheckedCreateInput {
  return { eventId: e.id, tenantId: e.tenantid, type: e.type, subject: e.subject, envelope: json(e), pending: OUTBOX_TARGETS };
}

export interface PersistSummary {
  created: number;
  updated: number;
  relationships: number;
  conflicts: number;
  events: number;
}

export async function persist(prisma: PrismaClient, tenantId: string, out: ReconcileOutput): Promise<PersistSummary> {
  return prisma.$transaction(async (tx) => {
    if (out.created.length) await tx.ci.createMany({ data: out.created.map(ciCreate), skipDuplicates: true });
    for (const ci of out.created) {
      if (ci.externalIds.length) {
        await tx.ciExternalId.createMany({ data: ci.externalIds.map((x) => ({ tenantId, ciId: ci.id, source: x.source, externalId: x.id })), skipDuplicates: true });
      }
    }
    await updateCisBatch(tx, out.updated);
    if (out.relationshipsCreated.length) await tx.relationship.createMany({ data: out.relationshipsCreated.map(relationshipCreate), skipDuplicates: true });
    if (out.relationshipsSeen.length) await tx.relationship.updateMany({ where: { id: { in: out.relationshipsSeen } }, data: { observedAt: new Date() } });
    for (const c of out.conflicts) {
      await tx.reconciliationConflict.create({
        data: { tenantId, type: c.observed.type, identityKey: identityKeyOf(c.observed.type, c.observed.identity), field: 'identity', candidates: json({ ciIds: c.ciIds, observed: c.observed }) },
      });
    }
    if (out.events.length) await tx.outboxEvent.createMany({ data: out.events.map(outboxCreate), skipDuplicates: true });
    return { created: out.created.length, updated: out.updated.length, relationships: out.relationshipsCreated.length, conflicts: out.conflicts.length, events: out.events.length };
  });
}
