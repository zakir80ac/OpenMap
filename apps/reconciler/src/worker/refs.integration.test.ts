// T-453 REQ-CORE-013 REQ-QA-005 — ADR-045 against the real Postgres (migration 0028), through processResult and the
// pending pass the replay runs:
// - an agent and a load balancer that name one listener's host differently (UUID, IP) yield one listener;
// - in the other order, with the host reported last, the two copies fold into one in the pending pass: the copy is
//   retired with an `openmap.ci.retired` event and its relationships move to the survivor;
// - the ServiceNow and Workday tenants that share the id horizonbank stay two CIs;
// - a CI another writer inserts is pending with no tokens until the pass computes them.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { CI_TYPE_LAYER, type CollectorResult, type ObservedCi } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendingProgressed, processResult, retryPendingRelationships } from './pipeline.js';

const prisma = createPrismaClient();
const organizationId = randomUUID();
const tenants = [randomUUID(), randomUUID(), randomUUID()] as const;
const at = new Date().toISOString();

function result(tenantId: string, collectorId: string, cis: ObservedCi[], relationships: CollectorResult['relationships'] = []): CollectorResult {
  const runId = randomUUID();
  return {
    jobId: runId, runId, tenantId, collectorId, nodeId: 'node-itest', status: 'success', startedAt: at, finishedAt: at, cis, relationships, samples: [],
    evidence: [], errors: [], metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: cis.length, relationshipsEmitted: relationships.length, durationMs: 1 },
    contractVersion: CONTRACT_VERSIONS.collector,
  };
}

function ci(type: ObservedCi['type'], identity: Record<string, string>, name: string, attributes: ObservedCi['attributes'] = {}): ObservedCi {
  return { type, identity, name, attributes, tags: [], externalIds: [], observedAt: at };
}

const uuid = randomUUID();
const vm = ci('vm', { instanceUuid: uuid, hypervisorRef: 'ahv-itest-01.bank.local', fqdn: 'api-itest-01.bank.local' }, 'api-itest-01', { ipAddress: '10.99.0.10' });
const byAgent = ci('listening_service', { hostRef: uuid, protocol: 'tcp', port: '8443' }, 'api-itest-01 tcp/8443', { process: 'java' });
const byLb = ci('listening_service', { hostRef: '10.99.0.10', protocol: 'tcp', port: '8443' }, 'api-itest-01:8443', { poolMemberState: 'up' });
const lb = ci('load_balancer', { serialNumber: 'A10-ITEST', managementIp: '10.99.0.2' }, 'lb-itest-01');
const pool = ci('listening_service', { hostRef: 'serial:a10-itest', protocol: 'tcp', port: 'pool-api' }, 'pool-api');
const poolMember = { type: 'depends_on' as const, from: { type: pool.type, identity: pool.identity }, to: { type: byLb.type, identity: byLb.identity }, attributes: {}, observedAt: at };
const lbResult = (tenantId: string) => result(tenantId, 'a10_thunder', [lb, pool, byLb], [poolMember]);

async function listeners(tenantId: string, port: string) {
  return prisma.ci.findMany({ where: { tenantId, type: 'listening_service', validTo: null, identity: { path: ['port'], equals: port } } });
}

async function drain(tenantId: string): Promise<void> {
  for (;;) if (!pendingProgressed(await retryPendingRelationships(prisma, tenantId))) return;
}

describe('identity refs (integration, ADR-045)', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Identity refs org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    for (const id of tenants) await prisma.tenant.create({ data: { id, organizationId, name: 'identity-refs', slug: 'identity-refs-' + id.slice(0, 8) } });
  });

  afterAll(async () => {
    for (const tenantId of tenants) {
      await prisma.outboxEvent.deleteMany({ where: { tenantId } });
      await prisma.pendingRelationship.deleteMany({ where: { tenantId } });
      await prisma.relationship.deleteMany({ where: { tenantId } });
      await prisma.ci.deleteMany({ where: { tenantId } });
    }
    await prisma.tenant.deleteMany({ where: { id: { in: [...tenants] } } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('keeps one listener when the host is known before either observer reports it', async () => {
    const tenantId = tenants[0];
    await processResult(prisma, result(tenantId, 'nutanix_ahv', [vm]));
    const first = await processResult(prisma, result(tenantId, 'agent', [byAgent]));
    expect(first.created).toBe(1);
    const second = await processResult(prisma, lbResult(tenantId));
    expect(second.created).toBe(2);
    const [listener, ...rest] = await listeners(tenantId, '8443');
    expect(rest).toHaveLength(0);
    expect(listener?.refKey).toMatch(/^listening_service\|ref=@[0-9a-f-]{36}\|tcp\|8443$/);
    expect((listener?.attributes as Record<string, unknown>)['poolMemberState']).toBe('up');
    const rels = await prisma.relationship.findMany({ where: { tenantId, validTo: null, type: 'depends_on' } });
    expect(rels.map((r) => r.toCiId)).toEqual([listener?.id]);
  });

  it('folds the copies two observers made before the host was known, in the pending pass', async () => {
    const tenantId = tenants[1];
    await processResult(prisma, lbResult(tenantId));
    await processResult(prisma, result(tenantId, 'agent', [byAgent]));
    expect(await listeners(tenantId, '8443')).toHaveLength(2);
    expect((await listeners(tenantId, '8443')).every((l) => l.refsPending)).toBe(true);
    await processResult(prisma, result(tenantId, 'nutanix_ahv', [vm]));
    await drain(tenantId);
    const live = await listeners(tenantId, '8443');
    expect(live).toHaveLength(1);
    const survivor = live[0]!;
    expect(survivor.refsPending).toBe(false);
    expect(survivor.refKey).not.toBeNull();
    const attributes = survivor.attributes as Record<string, unknown>;
    expect(attributes['poolMemberState']).toBe('up');
    expect(attributes['process']).toBe('java');
    const retired = await prisma.ci.findMany({ where: { tenantId, type: 'listening_service', validTo: { not: null } } });
    expect(retired).toHaveLength(1);
    const events = await prisma.outboxEvent.findMany({ where: { tenantId, type: 'openmap.ci.retired', subject: retired[0]!.id } });
    expect(events).toHaveLength(1);
    expect((events[0]!.envelope as { data: { mergedInto: string } }).data.mergedInto).toBe(survivor.id);
    const dependsOn = await prisma.relationship.findMany({ where: { tenantId, validTo: null, type: 'depends_on' } });
    expect(dependsOn.map((r) => r.toCiId)).toEqual([survivor.id]);
    expect(await prisma.relationship.count({ where: { tenantId, validTo: null, OR: [{ fromCiId: retired[0]!.id }, { toCiId: retired[0]!.id }] } })).toBe(0);
    // A later sweep of either observer updates the survivor.
    const again = await processResult(prisma, lbResult(tenantId));
    expect(again.created).toBe(0);
    expect(await listeners(tenantId, '8443')).toHaveLength(1);
  });

  it('keeps two SaaS tenants with one id at two vendors apart, and settles CIs other writers insert', async () => {
    const tenantId = tenants[2];
    const out = await processResult(prisma, result(tenantId, 'saas', [
      ci('saas_tenant', { vendor: 'ServiceNow', tenantId: 'horizonbank' }, 'horizonbank (ServiceNow)'),
      ci('saas_tenant', { vendor: 'Workday', tenantId: 'horizonbank' }, 'horizonbank (Workday)'),
    ]));
    expect(out.created).toBe(2);
    expect(out.updated).toBe(0);
    // A site the onboarding wizard writes: no set_config, so the trigger leaves it pending without tokens.
    const site = await prisma.ci.create({
      data: { tenantId, type: 'site', identity: { code: 'ITS' }, identityKey: 'its', name: 'ITS', displayName: 'Integration site', layer: CI_TYPE_LAYER.site, lifecycle: 'managed', attributes: {}, tags: [],
        sourceCollectorId: 'api', sourceNodeId: 'api', sourceRunId: organizationId, sourceConfidence: 1, observedAt: new Date(at), validFrom: new Date(at), checksum: 'c'.repeat(64) },
    });
    expect(site.refsPending).toBe(true);
    expect(site.refTokens).toEqual([]);
    await drain(tenantId);
    const settled = await prisma.ci.findUniqueOrThrow({ where: { id: site.id } });
    expect(settled.refsPending).toBe(false);
    expect(settled.refTokens).toContain('its');
    // A building a DCIM sweep reports names the site by its code; the ref resolves to the site the wizard wrote.
    await processResult(prisma, result(tenantId, 'dcim', [ci('building', { siteRef: 'its', name: 'Main' }, 'Main')]));
    const building = await prisma.ci.findFirstOrThrow({ where: { tenantId, type: 'building', validTo: null } });
    expect(building.refKey).toBe('building|ref=@' + site.id + '|main');
  });
});
