// T-166 REQ-CMDB-015 — discovery never overwrites what a person entered: a host created by a collector result gets
// custom field values and a hand-set lifecycle, a later sweep of the same host reports changed attributes and a tag,
// and after reconciliation the attributes and tags follow discovery while the custom fields and the lifecycle stay as
// the person left them. Runs the real pipeline against Postgres.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import type { CollectorResult } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processResult } from './pipeline.js';

const prisma = createPrismaClient();
const tenantId = randomUUID();
const organizationId = randomUUID();

function result(observedAt: string, attributes: Record<string, string | number>, tags: string[]): CollectorResult {
  const runId = randomUUID();
  return {
    jobId: runId,
    runId,
    tenantId,
    collectorId: 'ssh_agentless',
    nodeId: 'node-test',
    status: 'success',
    startedAt: observedAt,
    finishedAt: observedAt,
    cis: [{ type: 'host', identity: { serialNumber: 'SN-CF-1' }, name: 'srv-cf-01', attributes, tags, externalIds: [], observedAt }],
    relationships: [],
    samples: [],
    evidence: [],
    errors: [],
    metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: 1, relationshipsEmitted: 0, durationMs: 1 },
    contractVersion: CONTRACT_VERSIONS.collector,
  };
}

describe('custom fields survive discovery (integration)', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Custom fields org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'custom-fields', slug: 'custom-fields-' + tenantId.slice(0, 8) } });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('keeps custom fields and a hand-set lifecycle across a later sweep', async () => {
    await processResult(prisma, result('2026-11-05T08:00:00.000Z', { memoryGb: 256, osName: 'RHEL 9' }, ['linux']));
    const host = await prisma.ci.findFirstOrThrow({ where: { tenantId, type: 'host', validTo: null } });
    expect(host.customFields).toEqual({});
    await prisma.ci.update({ where: { id: host.id }, data: { customFields: { businessOwner: 'Treasury', dataTier: 'gold' }, lifecycle: 'managed' } });

    await processResult(prisma, result('2026-11-05T09:00:00.000Z', { memoryGb: 512, osName: 'RHEL 9.4' }, ['linux', 'prod']));
    const after = await prisma.ci.findFirstOrThrow({ where: { tenantId, type: 'host', validTo: null } });
    expect(after.id).toBe(host.id);
    expect(after.attributes).toMatchObject({ memoryGb: 512, osName: 'RHEL 9.4' });
    expect([...after.tags].sort()).toEqual(['linux', 'prod']);
    expect(after.customFields).toEqual({ businessOwner: 'Treasury', dataTier: 'gold' });
    expect(after.lifecycle).toBe('managed');
  });
});
