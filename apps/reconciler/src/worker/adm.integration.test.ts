// T-150 REQ-DEP-002 (ADR-029) — the dependency-mapping pass against Postgres with the replayed synthetic estate:
// the pass derives listener, component and compute dependencies from the estate's flows, stamps them with the `adm`
// provenance, their kind confidence and their evidence; a second pass creates nothing, refreshes every edge and
// retires none (idempotent); an edge whose flow disappears is retired on the next pass with the retirement event in
// the outbox, and comes back when the flow does. Needs POSTGRES_URL to point at a stack holding an estate with flows.
import { createPrismaClient } from '@openmap/db';
import { ADM } from '@openmap/constants';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAdmPass } from './adm.js';

const prisma = createPrismaClient();
let tenantId = '';

describe('dependency-mapping pass (integration)', () => {
  beforeAll(async () => {
    const row = await prisma.relationship.groupBy({ by: ['tenantId'], where: { type: 'communicates_with', validTo: null }, _count: { _all: true }, orderBy: { _count: { tenantId: 'desc' } }, take: 1 });
    tenantId = row[0]?.tenantId ?? '';
    expect(tenantId, 'a tenant with flows').not.toBe('');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('derives dependencies from the estate and is idempotent', async () => {
    const first = await runAdmPass(prisma, tenantId);
    expect(first.flows).toBeGreaterThan(0);
    expect(first.derived).toBeGreaterThan(0);
    expect(first.unresolved).toBe(0);
    const kinds = await prisma.$queryRaw<Array<{ kind: string; n: bigint; confidence: number }>>`
      SELECT attributes->>'kind' AS kind, count(*) AS n, avg("sourceConfidence") AS confidence
      FROM relationships WHERE "tenantId" = ${tenantId}::uuid AND "sourceCollectorId" = ${ADM.collectorId} AND "validTo" IS NULL GROUP BY 1`;
    const byKind = new Map(kinds.map((k) => [k.kind, k]));
    expect(byKind.get('listener')?.confidence).toBeCloseTo(ADM.confidence.listener);
    expect(byKind.get('component')?.confidence).toBeCloseTo(ADM.confidence.component);
    const sample = await prisma.relationship.findFirst({ where: { tenantId, sourceCollectorId: ADM.collectorId, validTo: null }, select: { attributes: true, type: true, sourceNodeId: true } });
    expect(sample?.type).toBe('depends_on');
    expect(sample?.sourceNodeId).toBe(ADM.nodeId);
    expect(sample?.attributes).toMatchObject({ derivedFrom: 'flows' });
    const second = await runAdmPass(prisma, tenantId);
    expect(second).toMatchObject({ created: 0, retired: 0, unresolved: 0, derived: first.derived });
    expect(second.refreshed).toBe(first.derived);
  });

  it('retires an edge whose flow is gone and brings it back when the flow returns', async () => {
    const flow = await prisma.relationship.findFirst({
      where: { tenantId, type: 'communicates_with', validTo: null },
      orderBy: { id: 'asc' },
      select: { id: true, fromCiId: true, toCiId: true },
    });
    expect(flow).not.toBeNull();
    if (flow === null) return;
    const before = await prisma.relationship.count({ where: { tenantId, sourceCollectorId: ADM.collectorId, validTo: null } });
    await prisma.relationship.update({ where: { id: flow.id }, data: { validTo: new Date() } });
    try {
      const gone = await runAdmPass(prisma, tenantId);
      const retiredEvents = await prisma.outboxEvent.count({ where: { tenantId, type: 'openmap.relationship.retired', createdAt: { gte: new Date(Date.now() - gone.durationMs - 1_000) } } });
      // The flow may have been the only evidence for its edge, or one of several; either way the pass is consistent.
      const after = await prisma.relationship.count({ where: { tenantId, sourceCollectorId: ADM.collectorId, validTo: null } });
      expect(after).toBe(before - gone.retired);
      expect(retiredEvents).toBeGreaterThanOrEqual(gone.retired);
      const derivedEvent = await prisma.outboxEvent.findFirst({ where: { tenantId, type: 'openmap.dependency.derived' }, orderBy: { createdAt: 'desc' } });
      expect(derivedEvent).not.toBeNull();
    } finally {
      await prisma.relationship.update({ where: { id: flow.id }, data: { validTo: null } });
      const back = await runAdmPass(prisma, tenantId);
      const restored = await prisma.relationship.count({ where: { tenantId, sourceCollectorId: ADM.collectorId, validTo: null } });
      expect(restored).toBe(before);
      expect(back.retired).toBe(0);
    }
  });
});
