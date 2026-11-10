// T-024 REQ-DISC-028 REQ-DISC-029 — job store against the compose Postgres: schedule → pull → complete.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@openmap/config';
import type { CollectorJob, CollectorResult } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createJobStore } from './jobs.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const store = createJobStore(prisma);
const organizationId = randomUUID();
const tenantId = randomUUID();
const siteId = randomUUID();
const nodeId = 'node-test-' + randomUUID().slice(0, 8);
const now = new Date().toISOString();

function job(id: string, collectorId = 'snmp'): CollectorJob {
  return {
    jobId: id, tenantId, collectorId, nodeId, targets: [{ kind: 'host', value: 'target-' + id.slice(0, 4) }], credentialRef: 'creds/snmp', credentialType: 'snmp_v3',
    timeoutMs: 1000, rateLimit: { concurrency: 4, requestsPerSecond: 10 }, options: {}, scheduledAt: now, contractVersion: '0.1.0',
  };
}

describe('job store', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Test org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Test tenant', slug: 'test-' + tenantId.slice(0, 8) } });
    await prisma.site.create({ data: { id: siteId, organizationId, code: 'TST', name: 'Test site', kind: 'datacenter', city: 'Riyadh', countryCode: 'SA', address: '', locationCount: 1 } });
    await prisma.discoveryNode.create({ data: { id: nodeId, tenantId, siteId, status: 'enrolled', collectorIds: ['snmp'] } });
  });
  afterAll(async () => {
    // discovery_nodes.siteId is ON DELETE RESTRICT: the node goes before the organization's sites cascade.
    await prisma.discoveryNode.deleteMany({ where: { tenantId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('schedules jobs, hands them out once, and records the result with evidence', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    expect(await store.schedule(ids.map((id) => job(id)))).toBe(3);
    const first = await store.pull(nodeId, 2, ['snmp']);
    const second = await store.pull(nodeId, 5, ['snmp']);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((j) => j.jobId))).toEqual(new Set(ids));
    expect(await store.pull(nodeId, 5, [])).toHaveLength(0);
    const result: CollectorResult = {
      jobId: ids[0]!, runId: randomUUID(), tenantId, collectorId: 'snmp', nodeId, status: 'partial', startedAt: now, finishedAt: now,
      cis: [], relationships: [], errors: [{ target: null, code: 'timeout', message: 'slow', retryable: true }],
      evidence: [{ kind: 'snmp_walk', target: { kind: 'host', value: 'x' }, digest: 'a'.repeat(64), sizeBytes: 10, capturedAt: now }],
      metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: 0, relationshipsEmitted: 0, durationMs: 3 }, contractVersion: '0.1.0',
    };
    const { runId } = await store.complete(result);
    const run = await prisma.collectorRun.findUnique({ where: { id: runId }, include: { evidence: true } });
    expect(run?.status).toBe('partial');
    expect(run?.evidence).toHaveLength(1);
    const done = await prisma.discoveryJob.findUnique({ where: { id: ids[0]! } });
    expect(done?.status).toBe('completed');
    const events = await prisma.outboxEvent.findMany({ where: { tenantId }, orderBy: { sequence: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['openmap.discovery.job.scheduled', 'openmap.discovery.job.started', 'openmap.discovery.job.completed']));
  });
  it('refuses a result from a node that does not own the job', async () => {
    const id = randomUUID();
    await store.schedule([job(id)]);
    await store.pull(nodeId, 1, []);
    const result: CollectorResult = { ...({} as CollectorResult), jobId: id, runId: randomUUID(), tenantId, collectorId: 'snmp', nodeId: 'node-impostor', status: 'success', startedAt: now, finishedAt: now, cis: [], relationships: [], errors: [], evidence: [], metrics: { targetsAttempted: 0, targetsReached: 0, cisEmitted: 0, relationshipsEmitted: 0, durationMs: 0 }, contractVersion: '0.1.0' };
    await expect(store.complete(result)).rejects.toThrow(/belongs to node/);
  });
});
