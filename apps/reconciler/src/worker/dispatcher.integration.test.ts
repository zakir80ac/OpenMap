// T-489 REQ-CORE-020 — outbox claims against the real Postgres (migration 0035):
// - two dispatchers draining one tenant's outbox together deliver every row to every target exactly once;
// - a row leased by a dispatcher that died is claimed again once its lease runs out, and not before.
// The sinks are in-process recorders: the claim is what is under test, and the stores have their own suites.
import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { CONTRACT_VERSIONS, RECONCILER } from '@openmap/constants';
import type { Ci, EventEnvelope } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import type { GraphRepository, GraphWriteBatch } from '@openmap/graph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchOnce, type Sinks } from './dispatcher.js';

const prisma = createPrismaClient();
const organizationId = randomUUID();
const tenantId = randomUUID();
const at = new Date().toISOString();
/** Enough rows for several batches, so the two dispatchers interleave. */
const rowCount = RECONCILER.outboxBatchSize * 4 + 17;

function envelope(id: string, ci: Ci): EventEnvelope {
  return {
    specversion: '1.0',
    id,
    source: '/openmap/reconciler',
    type: 'openmap.ci.created',
    subject: ci.id,
    time: at,
    datacontenttype: 'application/json',
    dataschema: 'https://openmap.dev/contracts/event-envelope/' + CONTRACT_VERSIONS.event,
    tenantid: tenantId,
    traceparent: '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01',
    data: { ci },
  };
}

function ci(n: number): Ci {
  return {
    id: randomUUID(),
    tenantId,
    type: 'host',
    identity: { fqdn: 'claim-' + String(n) + '.itest' },
    name: 'claim-' + String(n),
    displayName: 'claim-' + String(n),
    code: 'OS-CLAIM-' + String(n),
    layer: 'os',
    userLabel: null,
    lifecycle: 'discovered',
    attributes: {},
    tags: [],
    externalIds: [],
    source: { collectorId: 'itest', nodeId: 'node-itest', runId: randomUUID(), confidence: 1 },
    observedAt: at,
    validFrom: at,
    validTo: null,
    checksum: 'a'.repeat(64),
  };
}

/** Counts what each target received, by event id. */
function recordingSinks(seen: Map<string, Map<string, number>>): Sinks {
  const bump = (target: string, id: string) => {
    const byId = seen.get(target) ?? new Map<string, number>();
    byId.set(id, (byId.get(id) ?? 0) + 1);
    seen.set(target, byId);
  };
  const graph = {
    applyBatch: async (batch: GraphWriteBatch) => {
      for (const c of batch.cis) bump('memgraph', c.id);
      return { cis: batch.cis.length, relationships: 0, unmatchedRelationshipIds: [] };
    },
  } as unknown as GraphRepository;
  const clickhouse = {
    insert: async (args: { table: string; values: Array<{ event_id?: string }> }) => {
      if (args.table.endsWith('.events')) for (const v of args.values) if (v.event_id) bump('clickhouse', v.event_id);
      return {};
    },
  } as unknown as ClickHouseClient;
  return {
    graph,
    clickhouse,
    search: {
      indexCis: async (_tenant: string, cis: readonly Ci[]) => {
        for (const c of cis) bump('meilisearch', c.id);
      },
      dropTenant: async () => undefined,
    },
    stream: {
      publish: async (e: EventEnvelope) => bump('stream', e.id),
      publishMany: async (es: readonly EventEnvelope[]) => {
        for (const e of es) bump('stream', e.id);
      },
      close: async () => undefined,
    },
  };
}

describe('outbox claims (integration, REQ-CORE-020)', () => {
  const eventIds: string[] = [];
  const ciIds: string[] = [];

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Outbox claim org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'outbox-claims', slug: 'outbox-claims-' + tenantId.slice(0, 8) } });
    const data = Array.from({ length: rowCount }, (_, n) => {
      const c = ci(n);
      const eventId = randomUUID();
      eventIds.push(eventId);
      ciIds.push(c.id);
      return {
        eventId,
        tenantId,
        type: 'openmap.ci.created',
        subject: c.id,
        envelope: envelope(eventId, c) as unknown as object,
        pending: ['memgraph', 'clickhouse', 'meilisearch', 'websocket', 'bsm'] as Array<'memgraph' | 'clickhouse' | 'meilisearch' | 'websocket' | 'bsm'>,
      };
    });
    await prisma.outboxEvent.createMany({ data });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('delivers every row exactly once with two dispatchers draining together', async () => {
    const seen = new Map<string, Map<string, number>>();
    const sinks = recordingSinks(seen);
    const claimedBy = new Map<string, number>();
    const drain = async (dispatcherId: string): Promise<void> => {
      for (;;) {
        const r = await dispatchOnce(prisma, sinks, 'openmap', { dispatcherId, tenantId });
        if (r.claimed === 0) return;
        claimedBy.set(dispatcherId, (claimedBy.get(dispatcherId) ?? 0) + r.claimed);
      }
    };
    await Promise.all([drain('itest-a'), drain('itest-b')]);

    // Both took part, and between them every row was claimed once.
    expect(claimedBy.get('itest-a') ?? 0).toBeGreaterThan(0);
    expect(claimedBy.get('itest-b') ?? 0).toBeGreaterThan(0);
    expect((claimedBy.get('itest-a') ?? 0) + (claimedBy.get('itest-b') ?? 0)).toBe(rowCount);
    for (const [target, ids] of [['memgraph', ciIds], ['meilisearch', ciIds], ['clickhouse', eventIds], ['stream', eventIds]] as const) {
      const byId = seen.get(target) ?? new Map<string, number>();
      expect(byId.size, target).toBe(rowCount);
      expect([...byId.values()].every((n) => n === 1), target).toBe(true);
      expect(ids.every((id) => byId.has(id)), target).toBe(true);
    }
    const open = await prisma.outboxEvent.count({ where: { tenantId, OR: [{ deliveredAt: null }, { claimedBy: { not: null } }] } });
    expect(open).toBe(0);
  });

  it('claims a row again once a dead dispatcher’s lease runs out, and not before', async () => {
    const [expired, held] = eventIds.slice(0, 2);
    await prisma.outboxEvent.updateMany({ where: { tenantId }, data: { deliveredAt: new Date() } });
    await prisma.outboxEvent.update({ where: { eventId: expired! }, data: { deliveredAt: null, pending: ['bsm', 'websocket'], claimedBy: 'itest-dead', claimedUntil: new Date(Date.now() - RECONCILER.outboxIdleMs) } });
    await prisma.outboxEvent.update({ where: { eventId: held! }, data: { deliveredAt: null, pending: ['bsm', 'websocket'], claimedBy: 'itest-alive', claimedUntil: new Date(Date.now() + RECONCILER.outboxClaimLeaseMs) } });
    const seen = new Map<string, Map<string, number>>();
    const r = await dispatchOnce(prisma, recordingSinks(seen), 'openmap', { dispatcherId: 'itest-c', tenantId });
    expect(r).toMatchObject({ claimed: 1, delivered: 1, failures: [] });
    expect([...(seen.get('stream')?.keys() ?? [])]).toEqual([expired]);
    const still = await prisma.outboxEvent.findUnique({ where: { eventId: held! } });
    expect(still).toMatchObject({ deliveredAt: null, claimedBy: 'itest-alive' });
  });
});
