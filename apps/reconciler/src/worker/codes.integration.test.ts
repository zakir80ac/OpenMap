// T-457 REQ-CMDB-037 REQ-CORE-013 — short codes stay unique per tenant when one batch carries many CIs with the same
// name (every switch reports VLAN100-MGMT), and the trigger finds the next free suffix through the
// cis_tenant_code_pattern index (migration 0029) and a per-base counter (migration 0030) instead of counting every earlier
// suffix.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { type CollectorResult, type ObservedCi } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processResult } from './pipeline.js';

const prisma = createPrismaClient();
const organizationId = randomUUID();
const tenantId = randomUUID();
const at = new Date().toISOString();
const SWITCHES = 12;

function vlan(device: number): ObservedCi {
  return { type: 'vlan', identity: { deviceRef: 'serial:CODE-' + String(device), vlanId: '100' }, name: 'VLAN100-MGMT', attributes: {}, tags: [], externalIds: [], observedAt: at };
}

function result(cis: ObservedCi[]): CollectorResult {
  const runId = randomUUID();
  return {
    jobId: runId, runId, tenantId, collectorId: 'snmp', nodeId: 'node-itest', status: 'success', startedAt: at, finishedAt: at, cis, relationships: [], samples: [],
    evidence: [], errors: [], metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: cis.length, relationshipsEmitted: 0, durationMs: 1 },
    contractVersion: CONTRACT_VERSIONS.collector,
  };
}

describe('CI codes (integration, migration 0029)', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Codes org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'codes', slug: 'codes-' + tenantId.slice(0, 8) } });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.pendingRelationship.deleteMany({ where: { tenantId } });
    await prisma.ciCodeCounter.deleteMany({ where: { tenantId } });
    await prisma.ci.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('numbers same-named CIs of one batch and of a later batch in turn', async () => {
    const first = await processResult(prisma, result(Array.from({ length: SWITCHES }, (_, i) => vlan(i))));
    expect(first.created).toBe(SWITCHES);
    await processResult(prisma, result([vlan(SWITCHES)]));
    const codes = (await prisma.ci.findMany({ where: { tenantId, validTo: null }, select: { code: true } })).map((c) => c.code ?? '');
    const base = codes.find((c) => !/-\d+$/.test(c)) ?? '';
    expect(base).toMatch(/VLAN100-MGMT$/);
    expect(new Set(codes).size).toBe(SWITCHES + 1);
    const suffixes = codes.filter((c) => c !== base).map((c) => Number(c.slice(base.length + 1))).sort((a, b) => a - b);
    expect(suffixes).toEqual(Array.from({ length: SWITCHES }, (_, i) => i + 2));
  });

  it('hands out the next suffix from the per-base counter and skips a number already taken', async () => {
    const [counter] = await prisma.ciCodeCounter.findMany({ where: { tenantId } });
    expect(counter?.last).toBe(SWITCHES + 1);
    // Another writer takes the next number by hand; the trigger steps over it.
    const base = counter?.base ?? '';
    const manual = await prisma.ci.findFirstOrThrow({ where: { tenantId, validTo: null, code: base } });
    await prisma.ci.update({ where: { id: manual.id }, data: { code: base + '-' + String(SWITCHES + 2) } });
    await processResult(prisma, result([vlan(SWITCHES + 1)]));
    const codes = new Set((await prisma.ci.findMany({ where: { tenantId, validTo: null }, select: { code: true } })).map((c) => c.code));
    expect(codes.has(base)).toBe(true);
    expect(codes.size).toBe(SWITCHES + 2);
    // With the base free again, the new CI keeps the plain code; a later collision skips the hand-taken number.
    await processResult(prisma, result([vlan(SWITCHES + 2)]));
    const after = (await prisma.ci.findMany({ where: { tenantId, validTo: null }, select: { code: true } })).map((c) => c.code ?? '');
    expect(new Set(after).size).toBe(SWITCHES + 3);
    expect(after).toContain(base + '-' + String(SWITCHES + 3));
  });

  it('reads stored codes through the pattern index only to seed a base', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE tablename = 'cis' AND indexname = 'cis_tenant_code_pattern'`;
    expect(indexes[0]?.indexdef).toMatch(/text_pattern_ops\) WHERE \("validTo" IS NULL\)/);
    const fn = await prisma.$queryRaw<Array<{ def: string }>>`SELECT pg_get_functiondef('cis_unique_code'::regproc) AS def`;
    expect(fn[0]?.def).toContain('UPDATE ci_code_counters SET last = last + 1');
    expect(fn[0]?.def).toContain("code ~>=~ (code_base || '-')");
  });
});
