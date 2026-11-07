// T-458 REQ-CORE-013 — candidate CIs are found by identity token (migration 0031): the trigger gives every CI its
// "key=value" tokens whoever writes it, a later observation that carries one globally unique value (in another case)
// updates the stored CI instead of adding a second, and an identity change refreshes the tokens.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { CI_TYPE_LAYER, type CollectorResult, type ObservedCi } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processResult } from './pipeline.js';

const prisma = createPrismaClient();
const organizationId = randomUUID();
const tenantId = randomUUID();
const at = new Date().toISOString();

function result(cis: ObservedCi[]): CollectorResult {
  const runId = randomUUID();
  return {
    jobId: runId, runId, tenantId, collectorId: 'ssh_agentless', nodeId: 'node-itest', status: 'success', startedAt: at, finishedAt: at, cis, relationships: [], samples: [],
    evidence: [], errors: [], metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: cis.length, relationshipsEmitted: 0, durationMs: 1 },
    contractVersion: CONTRACT_VERSIONS.collector,
  };
}

describe('identity tokens (integration, migration 0031)', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Tokens org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'tokens', slug: 'tokens-' + tenantId.slice(0, 8) } });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.pendingRelationship.deleteMany({ where: { tenantId } });
    await prisma.ci.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('tokenises a CI another writer inserts, and a sweep naming it by its serial updates it', async () => {
    // The asset register writes a host by hand: serial and FQDN only.
    const manual = await prisma.ci.create({
      data: { tenantId, type: 'host', identity: { serialNumber: ' AB12CD ', fqdn: 'Pay-01.Bank.Local' }, identityKey: 'ab12cd|pay-01.bank.local', name: 'pay-01', displayName: 'pay-01', layer: CI_TYPE_LAYER.host, lifecycle: 'managed', attributes: {}, tags: [],
        sourceCollectorId: 'api', sourceNodeId: 'api', sourceRunId: organizationId, sourceConfidence: 1, observedAt: new Date(at), validFrom: new Date(at), checksum: 'c'.repeat(64) },
    });
    expect(manual.identityTokens).toEqual(['fqdn=pay-01.bank.local', 'serialNumber=ab12cd']);
    // SSH reports the same host with its UUID and MAC as well; the serial is enough to find it.
    const out = await processResult(prisma, result([{ type: 'host', identity: { serialNumber: 'ab12cd', systemUuid: 'U-1', primaryMac: '00:11:22:33:44:55' }, name: 'pay-01', attributes: { os: 'linux' }, tags: [], externalIds: [], observedAt: at }]));
    expect(out.created).toBe(0);
    expect(out.updated).toBe(1);
    const hosts = await prisma.ci.findMany({ where: { tenantId, type: 'host', validTo: null } });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.identityTokens).toEqual(expect.arrayContaining(['systemUuid=u-1', 'primaryMac=00:11:22:33:44:55', 'serialNumber=ab12cd']));
  });

  it('probes the tokens through the partial GIN index on current rows', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE tablename = 'cis' AND indexname = 'cis_identity_tokens_idx'`;
    expect(indexes[0]?.indexdef).toMatch(/USING gin \("identityTokens"\) WHERE \("validTo" IS NULL\)/);
  });
});
