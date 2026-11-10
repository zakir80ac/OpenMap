// T-613 REQ-PERF-005 (ADR-071) — the reconciler's platform gauges against the compose stores:
// - every store answers its probe (PostgreSQL, Memgraph, ClickHouse over TLS, Valkey, Meilisearch), and a probe that
//   hangs is reported down within the timeout rather than stalling the scrape;
// - an undelivered outbox row shows in the backlog with its age, and leaves it once delivered;
// - the job counts of a queue follow the jobs added to it;
// - one scrape of the registry serves every gauge from a single snapshot.
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { CONTRACT_VERSIONS, PLATFORM_HEALTH, TIME } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { createRegistry } from '@openmap/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClickHouse } from './dispatcher.js';
import { probeStores, readOutboxBacklog, readQueueDepths, registerPlatformGauges, type StoreProbes } from './platform-gauges.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const graph = createGraphRepository(env);
const clickhouse = createClickHouse(env);
const connection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
const queue = new Queue('openmap-itest-platform-' + randomUUID(), { connection });
const organizationId = randomUUID();
const tenantId = randomUUID();
const eventId = randomUUID();
const ageSeconds = 90;
const meiliHealth = new URL('health', env.MEILI_URL.endsWith('/') ? env.MEILI_URL : env.MEILI_URL + '/');

const probes: StoreProbes = {
  postgres: () => prisma.$queryRaw`SELECT 1`,
  memgraph: () => graph.readOnly('RETURN 1 AS ok', {}),
  clickhouse: async () => {
    const ping = await clickhouse.ping();
    if (!ping.success) throw ping.error;
  },
  valkey: () => connection.ping(),
  meilisearch: async () => {
    const res = await fetch(meiliHealth);
    if (!res.ok) throw new Error(String(res.status));
  },
};

describe('platform gauges (integration)', () => {
  beforeAll(async () => {
    await prisma.organization.create({
      data: { id: organizationId, name: 'Platform gauges org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false },
    });
    await prisma.tenant.create({
      data: { id: tenantId, organizationId, name: 'platform-gauges', slug: 'platform-gauges-' + tenantId.slice(0, 8) },
    });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
    await clickhouse.close();
    await graph.close();
    await prisma.$disconnect();
  });

  it('finds every store up, and a hung one down within the timeout', async () => {
    const states = await probeStores(probes);
    expect(states.map((s) => [s.store, s.up])).toEqual(PLATFORM_HEALTH.probedStores.map((s) => [s, true]));
    const timeoutMs = 200;
    const started = Date.now();
    const hung = await probeStores({ ...probes, memgraph: () => new Promise(() => undefined) }, timeoutMs);
    expect(hung.find((s) => s.store === 'memgraph')?.up).toBe(false);
    expect(hung.filter((s) => s.store !== 'memgraph').every((s) => s.up)).toBe(true);
    expect(Date.now() - started).toBeLessThan(PLATFORM_HEALTH.storeProbeTimeoutMs);
  });

  it('counts an undelivered outbox row and its age until it is delivered', async () => {
    const before = await readOutboxBacklog(prisma);
    const createdAt = new Date(Date.now() - ageSeconds * TIME.msPerSecond);
    await prisma.outboxEvent.create({
      data: {
        eventId,
        tenantId,
        type: 'openmap.ci.created',
        subject: randomUUID(),
        envelope: { specversion: '1.0', id: eventId, dataschema: 'event-envelope/' + CONTRACT_VERSIONS.event },
        pending: ['memgraph'],
        createdAt,
        // Leased far ahead so the compose reconciler's dispatcher leaves the row alone while the test reads it.
        claimedBy: 'platform-gauges-itest',
        claimedUntil: new Date(Date.now() + TIME.msPerHour),
      },
    });
    const waiting = await readOutboxBacklog(prisma);
    expect(waiting.pending).toBe(before.pending + 1);
    expect(waiting.oldestAgeSeconds).toBeGreaterThanOrEqual(ageSeconds);
    await prisma.outboxEvent.update({ where: { eventId }, data: { deliveredAt: new Date(), pending: [] } });
    expect((await readOutboxBacklog(prisma)).pending).toBe(before.pending);
  });

  it('follows the jobs in a queue per state', async () => {
    await queue.addBulk([{ name: 'a', data: {} }, { name: 'b', data: {} }, { name: 'c', data: {}, opts: { delay: TIME.msPerHour } }]);
    const depths = await readQueueDepths([queue]);
    expect(depths).toEqual([
      { queue: queue.name, state: 'waiting', jobs: 2 },
      { queue: queue.name, state: 'active', jobs: 0 },
      { queue: queue.name, state: 'delayed', jobs: 1 },
      { queue: queue.name, state: 'failed', jobs: 0 },
    ]);
  });

  it('serves every gauge from one snapshot per scrape', async () => {
    const registry = createRegistry();
    let probesRun = 0;
    const counted: StoreProbes = { ...probes, postgres: async () => { probesRun += 1; return probes.postgres(); } };
    registerPlatformGauges(registry, { prisma, probes: counted, queues: [queue], tracer: 'platform-gauges-itest' });
    const text = await registry.metrics();
    expect(probesRun).toBe(1);
    const M = PLATFORM_HEALTH.metrics;
    for (const store of PLATFORM_HEALTH.probedStores) expect(text).toContain(M.storeUp + '{store="' + store + '"} 1');
    expect(text).toMatch(new RegExp('^' + M.outboxPending + ' \\d+$', 'mu'));
    expect(text).toMatch(new RegExp('^' + M.outboxOldest + ' [\\d.e+-]+$', 'mu'));
    expect(text).toContain(M.queueJobs + '{queue="' + queue.name + '",state="waiting"} 2');
    expect(text).toContain(M.storeProbeSeconds + '{store="clickhouse"}');
  });
});
