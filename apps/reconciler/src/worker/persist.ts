// REQ-CORE-013 REQ-CORE-005 — writes a ReconcileOutput to Postgres in one transaction together
// with its outbox events. Nothing else writes CIs; every other store learns through the outbox.
import type { Ci, EventEnvelope, Relationship } from '@openmap/contracts';
import type { Prisma, PrismaClient } from '@openmap/db';
import { identityKeyOf } from './lookup.js';
import type { ReconcileOutput } from '../core/reconcile.js';

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
    for (const ci of out.updated) {
      await tx.ci.update({
        where: { id: ci.id },
        data: {
          identity: json(ci.identity),
          identityKey: identityKeyOf(ci.type, ci.identity),
          attributes: json(ci.attributes),
          tags: ci.tags,
          sourceCollectorId: ci.source.collectorId,
          sourceNodeId: ci.source.nodeId,
          sourceRunId: ci.source.runId,
          sourceConfidence: ci.source.confidence,
          observedAt: new Date(ci.observedAt),
          checksum: ci.checksum,
        },
      });
    }
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
