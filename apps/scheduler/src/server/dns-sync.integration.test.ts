// T-516 REQ-IPAM-003 (ADR-055) — the DNS sync round and settlement against the compose Postgres:
// - a zone kept in sync with two pending changes gets one dns job on the site's online Node, carrying both changes,
//   its server, port, TSIG key and credential; the changes become sent; a second round adds no job while it runs;
// - the job's result settles the changes from its transfer: the added record present and the deleted one absent are
//   applied, and the zone records its push and pull;
// - a failed job fails the changes it carried with its error and leaves the zone's error.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@openmap/config';
import { CONTRACT_VERSIONS, DNS_SYNC } from '@openmap/constants';
import type { CollectorResult, ObservedCi } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { planDnsRound } from './dns-sync-loop.js';
import { createJobStore } from './jobs.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const store = createJobStore(prisma);
const organizationId = randomUUID();
const tenantId = randomUUID();
const siteId = randomUUID();
const nodeId = 'node-dns-' + randomUUID().slice(0, 8);
const ZONE = 'itest-' + tenantId.slice(0, 6) + '.example';
const HOUR = 3_600_000;

function record(name: string, type: string, value: string): ObservedCi {
  return { type: 'dns_record', identity: { zoneRef: ZONE, name, recordType: type, value }, name: name + ' ' + type, attributes: {}, tags: [], externalIds: [], observedAt: new Date().toISOString() };
}

function result(jobId: string, status: CollectorResult['status'], cis: ObservedCi[], error: string | null = null): CollectorResult {
  const at = new Date().toISOString();
  return {
    jobId, runId: randomUUID(), tenantId, collectorId: DNS_SYNC.collectorId, nodeId, status, startedAt: at, finishedAt: at, cis, relationships: [], samples: [], evidence: [],
    errors: error === null ? [] : [{ target: null, code: 'permission_denied', message: error, retryable: false }],
    metrics: { targetsAttempted: 1, targetsReached: status === 'failed' ? 0 : 1, cisEmitted: cis.length, relationshipsEmitted: 0, durationMs: 5 }, contractVersion: CONTRACT_VERSIONS.collector,
  };
}

describe('dns sync round and settlement (integration)', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'DNS org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'DNS tenant', slug: 'dns-' + tenantId.slice(0, 8) } });
    await prisma.site.create({ data: { id: siteId, organizationId, code: 'DNS', name: 'DNS site', kind: 'datacenter', city: 'Riyadh', countryCode: 'SA', address: '', locationCount: 1 } });
    await prisma.discoveryNode.create({ data: { id: nodeId, tenantId, siteId, status: 'enrolled', collectorIds: ['dns'], lastHeartbeatAt: new Date() } });
    await prisma.dnsZoneSync.create({ data: { tenantId, zone: ZONE, server: '10.9.0.53', port: 53, tsigKeyName: 'openmap-sync', credentialRef: 'cred/dns', siteId } });
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('sends the pending changes with one job and settles them from its transfer', async () => {
    await prisma.dnsChange.createMany({
      data: [
        { tenantId, zone: ZONE, op: 'add', name: 'api.' + ZONE, recordType: 'A', value: '10.9.0.81', ttl: 600, state: 'pending', requestedBy: 'itest' },
        { tenantId, zone: ZONE, op: 'delete', name: 'old.' + ZONE, recordType: 'A', value: '10.9.0.70', ttl: 600, state: 'pending', requestedBy: 'itest' },
      ],
    });
    const round = await planDnsRound(prisma, store, HOUR);
    expect(round).toMatchObject({ scheduled: 1, sent: 2, unassigned: [] });
    const job = await prisma.discoveryJob.findFirst({ where: { tenantId, collectorId: DNS_SYNC.collectorId } });
    const options = job?.options as Record<string, unknown>;
    expect(options['zones']).toEqual([ZONE]);
    expect(options['tsigKeyName']).toBe('openmap-sync');
    expect((options['updates'] as unknown[]).length).toBe(2);
    expect(job?.credentialRef).toBe('cred/dns');
    const sent = await prisma.dnsChange.findMany({ where: { tenantId } });
    expect(sent.every((c) => c.state === 'sent' && c.jobId === job?.id)).toBe(true);
    expect((await planDnsRound(prisma, store, HOUR)).scheduled).toBe(0);

    await store.complete(result(job?.id ?? '', 'success', [record('api.' + ZONE, 'A', '10.9.0.81'), record('www.' + ZONE, 'A', '10.9.0.80')]));
    const settled = await prisma.dnsChange.findMany({ where: { tenantId } });
    expect(settled.map((c) => c.state)).toEqual(['applied', 'applied']);
    const sync = await prisma.dnsZoneSync.findFirst({ where: { tenantId } });
    expect(sync?.lastPushAt).not.toBeNull();
    expect(sync?.lastPullAt).not.toBeNull();
    expect(sync?.lastError).toBeNull();
  });

  it('fails the changes a failed job carried', async () => {
    await prisma.dnsChange.create({ data: { tenantId, zone: ZONE, op: 'add', name: 'db.' + ZONE, recordType: 'A', value: '10.9.0.90', ttl: 600, state: 'pending', requestedBy: 'itest' } });
    await planDnsRound(prisma, store, HOUR);
    const change = await prisma.dnsChange.findFirst({ where: { tenantId, name: 'db.' + ZONE } });
    expect(change?.state).toBe('sent');
    await store.complete(result(change?.jobId ?? '', 'failed', [], '10.9.0.53 refused lab update (check the TSIG key)'));
    const failed = await prisma.dnsChange.findFirst({ where: { tenantId, name: 'db.' + ZONE } });
    expect(failed).toMatchObject({ state: 'failed', error: '10.9.0.53 refused lab update (check the TSIG key)' });
    expect((await prisma.dnsZoneSync.findFirst({ where: { tenantId } }))?.lastError).toContain('TSIG');
  });
});
