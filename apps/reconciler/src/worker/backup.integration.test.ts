// T-656 REQ-INT-017 (ADR-075) — a backup collector result through processResult against the real Postgres, in a tenant
// of its own. A discovery result first stores a VM (instance UUID, hypervisor, FQDN) and a host (serial only). The
// backup result, shaped as apps/collectors/internal/backup emits it, then:
// - stores its Veeam job and Commvault plan as backup_policy CIs (the migration 0052 enum value) by vendor, server, id;
// - resolves the VM's backed_by edge named with the identity the planner's inventory carried, and the host's likewise;
// - resolves a second VM edge named by FQDN alone (the fallback when no inventory entry matched);
// - parks the edge of an object the CMDB does not hold (an unknown FQDN) as pending instead of inventing a CI;
// and re-observing the same result changes nothing.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import type { CollectorResult, ObservedCi, ObservedRelationship } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processResult } from './pipeline.js';

const prisma = createPrismaClient();
const organizationId = randomUUID();
const tenantId = randomUUID();
const at = new Date(Date.now() - 600_000).toISOString();
const later = new Date(Date.now() - 300_000).toISOString();
const suffix = tenantId.slice(0, 8);

function result(collectorId: string, cis: ObservedCi[], relationships: ObservedRelationship[], observedAt: string): CollectorResult {
  const runId = randomUUID();
  return {
    jobId: randomUUID(),
    runId,
    tenantId,
    collectorId,
    nodeId: 'node-itest',
    status: 'success',
    startedAt: observedAt,
    finishedAt: observedAt,
    cis,
    relationships,
    samples: [],
    evidence: [],
    errors: [],
    metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: cis.length, relationshipsEmitted: relationships.length, durationMs: 1 },
    contractVersion: CONTRACT_VERSIONS.collector,
  };
}

const ci = (type: ObservedCi['type'], name: string, identity: Record<string, string>, attributes: ObservedCi['attributes'], observedAt: string): ObservedCi => ({
  type,
  identity,
  name,
  attributes,
  tags: [],
  externalIds: [],
  observedAt,
});

const vmIdentity = { instanceUuid: '5035a1b2-0c3d-4e5f-8a9b-' + suffix + '0000', hypervisorRef: 'esx-bk-' + suffix, fqdn: 'pay-vm-01.' + suffix + '.example' };
const vm2Identity = { instanceUuid: '5035a1b2-0c3d-4e5f-8a9b-' + suffix + '0001', hypervisorRef: 'esx-bk-' + suffix, fqdn: 'pay-vm-02.' + suffix + '.example' };
const hostIdentity = { serialNumber: 'BK-HOST-' + suffix };
const discovery = (): CollectorResult =>
  result(
    'vmware',
    [ci('vm', 'pay-vm-01', vmIdentity, { platform: 'vmware' }, at), ci('vm', 'pay-vm-02', vm2Identity, { platform: 'vmware' }, at), ci('host', 'db-bk-01', hostIdentity, { fqdn: 'db-bk-01.' + suffix + '.example' }, at)],
    [],
    at,
  );

const job = { vendor: 'veeam', serverId: 'vbr-' + suffix, policyId: 'job-1' };
const plan = { vendor: 'commvault', serverId: 'cs-' + suffix + '.example', policyId: 'plan-3' };
const backup = (): CollectorResult =>
  result(
    'backup',
    [
      ci('backup_policy', 'VBR Payments 4h', job, { ...job, server: 'vbr.example:9419', policyKind: 'job', rpoMinutes: 240, retentionDays: 14, enabled: true, lastResult: 'success', protectedObjects: 3, unmatchedObjects: 0, unmatchedNames: [] }, later),
      ci('backup_policy', 'Database Gold', plan, { ...plan, server: 'cs.example', policyKind: 'plan', rpoMinutes: 60, retentionDays: 30, enabled: true, lastResult: 'success', protectedObjects: 1, unmatchedObjects: 0, unmatchedNames: [] }, later),
    ],
    [
      { type: 'backed_by', from: { type: 'vm', identity: vmIdentity }, to: { type: 'backup_policy', identity: job }, attributes: { vendor: 'veeam', objectName: 'pay-vm-01', lastGoodBackupAt: later, lastResult: 'success', restorePoints: 14 }, observedAt: later },
      { type: 'backed_by', from: { type: 'vm', identity: { fqdn: vm2Identity.fqdn } }, to: { type: 'backup_policy', identity: job }, attributes: { vendor: 'veeam', objectName: 'pay-vm-02', lastGoodBackupAt: later, lastResult: 'warning', restorePoints: 13 }, observedAt: later },
      { type: 'backed_by', from: { type: 'vm', identity: { fqdn: 'ghost.' + suffix + '.example' } }, to: { type: 'backup_policy', identity: job }, attributes: { vendor: 'veeam', objectName: 'ghost', restorePoints: 0, lastResult: 'none' }, observedAt: later },
      { type: 'backed_by', from: { type: 'host', identity: hostIdentity }, to: { type: 'backup_policy', identity: plan }, attributes: { vendor: 'commvault', objectName: 'db-bk-01', lastGoodBackupAt: later, lastResult: 'success', agents: ['File System', 'SQL Server'], subclients: ['default'] }, observedAt: later },
    ],
    later,
  );

describe('backup collector results (integration, REQ-INT-017)', () => {
  beforeAll(async () => {
    await prisma.organization.create({
      data: { id: organizationId, name: 'Backup awareness org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false },
    });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'backup-awareness', slug: 'backup-aw-' + suffix } });
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

  it('stores the policies and resolves backed_by edges to the CIs discovery stored, parking the unknown one', async () => {
    await processResult(prisma, discovery());
    const first = await processResult(prisma, backup());
    expect(first.created).toBe(2);
    expect(first.relationships).toBe(3);
    expect(first.unresolvedRelationships).toBe(1);

    const policies = await prisma.ci.findMany({ where: { tenantId, type: 'backup_policy', validTo: null }, orderBy: { name: 'asc' } });
    expect(policies.map((p) => [p.name, p.layer, p.identity])).toEqual([
      ['Database Gold', 'storage', plan],
      ['VBR Payments 4h', 'storage', job],
    ]);
    const edges = await prisma.relationship.findMany({ where: { tenantId, type: 'backed_by', validTo: null } });
    const byId = new Map((await prisma.ci.findMany({ where: { tenantId } })).map((c) => [c.id, c.name]));
    expect(edges.map((e) => [byId.get(e.fromCiId), byId.get(e.toCiId)]).sort()).toEqual([
      ['db-bk-01', 'Database Gold'],
      ['pay-vm-01', 'VBR Payments 4h'],
      ['pay-vm-02', 'VBR Payments 4h'],
    ]);
    const host = edges.find((e) => byId.get(e.fromCiId) === 'db-bk-01');
    expect(host?.attributes).toMatchObject({ agents: ['File System', 'SQL Server'], lastGoodBackupAt: later });
    expect(await prisma.ci.count({ where: { tenantId, type: 'vm' } })).toBe(2);
    expect(await prisma.pendingRelationship.count({ where: { tenantId } })).toBe(1);

    const again = await processResult(prisma, backup());
    expect(again.created).toBe(0);
    expect(again.relationships).toBe(0);
    expect(again.relationshipsUpdated).toBe(0);
    expect(await prisma.relationship.count({ where: { tenantId, type: 'backed_by', validTo: null } })).toBe(3);
  });
});
