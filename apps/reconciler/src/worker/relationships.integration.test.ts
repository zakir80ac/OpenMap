// T-545 REQ-CORE-021 — relationship re-observation against the real Postgres through processResult: a host powered by
// a PDU outlet is observed, then observed again on another outlet (the stored edge's attributes change, the observing
// run becomes its source and `openmap.relationship.updated` is queued with the changed keys), then observed again
// unchanged (no event, only observedAt refreshed).
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import type { CollectorResult, ObservedCi } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processResult } from './pipeline.js';

const prisma = createPrismaClient();
const organizationId = randomUUID();
const tenantId = randomUUID();
// Observations sit in the past: an unchanged re-observation stamps the reconciler's clock, which must come after them.
const at = new Date(Date.now() - 600_000).toISOString();

function result(
  runId: string,
  cis: ObservedCi[],
  relationships: CollectorResult['relationships'],
  observedAt: string,
): CollectorResult {
  return {
    jobId: runId,
    runId,
    tenantId,
    collectorId: 'apc_pdu',
    nodeId: 'node-itest',
    status: 'success',
    startedAt: observedAt,
    finishedAt: observedAt,
    cis,
    relationships,
    samples: [],
    evidence: [],
    errors: [],
    metrics: {
      targetsAttempted: 1,
      targetsReached: 1,
      cisEmitted: cis.length,
      relationshipsEmitted: relationships.length,
      durationMs: 1,
    },
    contractVersion: CONTRACT_VERSIONS.collector,
  };
}

const host: ObservedCi = {
  type: 'host',
  identity: { serialNumber: 'REL-ITEST-HOST' },
  name: 'srv-rel-itest-01',
  attributes: {},
  tags: [],
  externalIds: [],
  observedAt: at,
};
const pdu: ObservedCi = {
  type: 'pdu',
  identity: { serialNumber: 'REL-ITEST-PDU' },
  name: 'PDU-REL-ITEST',
  attributes: {},
  tags: [],
  externalIds: [],
  observedAt: at,
};
const poweredBy = (
  attributes: Record<string, unknown>,
  observedAt: string,
): CollectorResult['relationships'][number] => ({
  type: 'powered_by',
  from: { type: 'host', identity: host.identity },
  to: { type: 'pdu', identity: pdu.identity },
  attributes,
  observedAt,
});

async function storedEdge() {
  return prisma.relationship.findFirstOrThrow({ where: { tenantId, type: 'powered_by', validTo: null } });
}

async function updatedEvents() {
  return prisma.outboxEvent.findMany({
    where: { tenantId, type: 'openmap.relationship.updated' },
    orderBy: { sequence: 'asc' },
  });
}

describe('relationship re-observation (integration, REQ-CORE-021)', () => {
  beforeAll(async () => {
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Relationship re-observation org',
        industry: 'test',
        timeZone: 'UTC',
        defaultLocale: 'en',
        regulatoryScope: [],
        airGapped: false,
      },
    });
    await prisma.tenant.create({
      data: {
        id: tenantId,
        organizationId,
        name: 'rel-reobserve',
        slug: 'rel-reobserve-' + tenantId.slice(0, 8),
      },
    });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.pendingRelationship.deleteMany({ where: { tenantId } });
    await prisma.relationship.deleteMany({ where: { tenantId } });
    await prisma.assetRecord.deleteMany({ where: { tenantId } });
    await prisma.ci.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('updates the stored edge and queues one update event when the outlet changes, and stays quiet when it does not', async () => {
    const first = await processResult(
      prisma,
      result(randomUUID(), [host, pdu], [poweredBy({ outlet: 7, phase: 'A' }, at)], at),
    );
    expect(first.relationships).toBe(1);
    expect(first.relationshipsUpdated).toBe(0);
    const created = await storedEdge();
    expect(created.attributes).toEqual({ outlet: 7, phase: 'A' });
    expect(await updatedEvents()).toHaveLength(0);

    const later = new Date(Date.parse(at) + 60_000).toISOString();
    const moveRun = randomUUID();
    const second = await processResult(
      prisma,
      result(moveRun, [host, pdu], [poweredBy({ outlet: 9 }, later)], later),
    );
    expect(second.relationships).toBe(0);
    expect(second.relationshipsUpdated).toBe(1);
    const moved = await storedEdge();
    expect(moved.id).toBe(created.id);
    expect(moved.attributes).toEqual({ outlet: 9, phase: 'A' });
    expect(moved.sourceRunId).toBe(moveRun);
    expect(moved.observedAt.toISOString()).toBe(later);
    expect(moved.validFrom.toISOString()).toBe(created.validFrom.toISOString());
    const events = await updatedEvents();
    expect(events).toHaveLength(1);
    const payload = (
      events[0]?.envelope as {
        data: { relationship: { id: string; attributes: Record<string, unknown> }; changedKeys: string[] };
      }
    ).data;
    expect(payload.relationship.id).toBe(created.id);
    expect(payload.relationship.attributes).toEqual({ outlet: 9, phase: 'A' });
    expect(payload.changedKeys).toEqual(['outlet']);

    const again = new Date(Date.parse(later) + 60_000).toISOString();
    const third = await processResult(
      prisma,
      result(randomUUID(), [host, pdu], [poweredBy({ outlet: 9 }, again)], again),
    );
    expect(third.relationshipsUpdated).toBe(0);
    expect(await updatedEvents()).toHaveLength(1);
    const unchanged = await storedEdge();
    expect(unchanged.attributes).toEqual({ outlet: 9, phase: 'A' });
    expect(unchanged.sourceRunId).toBe(moveRun);
    expect(unchanged.observedAt.getTime()).toBeGreaterThan(moved.observedAt.getTime());
  });
});
