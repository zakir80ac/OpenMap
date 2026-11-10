// T-655 REQ-INT-017 (ADR-075) — backup protection against the compose stack (Postgres and Memgraph), in a tenant of its
// own. A tier-1 payments service (RPO 60 min) runs on three VMs and two database clusters; a tier-3 intranet on one VM:
// - pay-vm-01 is in a Veeam job (RPO 240) backed up 30 minutes ago: protected against the service's 60;
// - pay-vm-02 is in the same job, last good backup three hours ago: past the RPO;
// - pay-vm-03 has no backup policy, only a storage `backed_by` to a database cluster, which is not a cover: unprotected;
// - the ledger cluster is hosted on a host a Commvault plan protects with the SQL Server agent: it inherits the cover;
// - the archive cluster's host is protected with File System only, which is not application-aware: unprotected;
// - the gaps list for tier 2 holds the seven CIs of the payments service, unprotected first; tier 3 adds the intranet VM.
// GraphQL serves the same through its resolvers, and the read is counted in openmap_protection_reads_total.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadEnv } from '@openmap/config';
import { CI_TYPE_LAYER, type CiType, type RelationshipType } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import { MetricsService, PROTECTION_METRIC } from '../metrics/metrics.service.js';
import { ProtectionService } from './protection.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const graph = createGraphRepository(env);
const TIMEOUT_MS = 120_000;
const MINUTE_MS = 60_000;
const KID = 'openmap-protection-key';
const organizationId = randomUUID();
const tenantId = randomUUID();
const now = new Date();
const ago = (minutes: number): string => new Date(now.getTime() - minutes * MINUTE_MS).toISOString();
let app: NestFastifyApplication;
let token = '';
const ids: Record<string, string> = {};
const id = (k: string): string => ids[k] ?? '';
const graphCis: Array<{ id: string; type: CiType; name: string; tier: number | null }> = [];
const graphRels: Array<{ id: string; type: RelationshipType; from: string; to: string }> = [];

async function ci(key: string, type: CiType, name: string, identity: Record<string, string>, attributes: Record<string, unknown> = {}): Promise<void> {
  const ciId = randomUUID();
  ids[key] = ciId;
  await prisma.ci.create({
    data: {
      id: ciId,
      tenantId,
      type,
      identity,
      identityKey: Object.values(identity).join('|'),
      name,
      displayName: name,
      code: 'PRT-' + ciId.slice(0, 8).toUpperCase(),
      layer: CI_TYPE_LAYER[type],
      lifecycle: 'discovered',
      attributes: attributes as object,
      tags: [],
      sourceCollectorId: 'itest',
      sourceNodeId: 'itest',
      sourceRunId: randomUUID(),
      sourceConfidence: 1,
      observedAt: now,
      validFrom: now,
      checksum: 'c'.repeat(64),
    },
  });
  const tier = typeof attributes['tier'] === 'number' ? attributes['tier'] : null;
  graphCis.push({ id: ciId, type, name, tier });
}

async function rel(type: RelationshipType, from: string, to: string, attributes: Record<string, unknown> = {}): Promise<void> {
  const relId = randomUUID();
  await prisma.relationship.create({
    data: {
      id: relId,
      tenantId,
      type,
      fromCiId: id(from),
      toCiId: id(to),
      attributes: attributes as object,
      sourceCollectorId: 'itest',
      sourceNodeId: 'itest',
      sourceRunId: randomUUID(),
      sourceConfidence: 1,
      observedAt: now,
      validFrom: now,
    },
  });
  graphRels.push({ id: relId, type, from: id(from), to: id(to) });
}

async function policy(key: string, vendor: string, name: string, kind: string, rpoMinutes: number): Promise<void> {
  await ci(
    key,
    'backup_policy',
    name,
    { vendor, serverId: 'srv-' + vendor, policyId: key },
    { vendor, serverId: 'srv-' + vendor, server: vendor + '.prt.example', policyId: key, policyKind: kind, rpoMinutes, retentionDays: 14, enabled: true, lastResult: 'success' },
  );
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<{ data: T | null; errors: Array<{ message: string }> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    payload: { query, variables },
  });
  const body = JSON.parse(res.body) as { data?: T | null; errors?: Array<{ message: string }> };
  return { data: body.data ?? null, errors: body.errors ?? [] };
}

describe('backup protection (integration)', () => {
  beforeAll(async () => {
    const keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    token = await new SignJWT({ tenant: tenantId, preferred_username: 'protection', realm_access: { roles: [ROLES.analyst] }, azp: env.KEYCLOAK_CLIENT_ID })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
      .setIssuer(realmUrl(env).toString())
      .setSubject('protection-' + randomUUID())
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(createLocalJWKSet({ keys: [jwk] }))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await prisma.organization.create({
      data: { id: organizationId, name: 'Protection org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true },
    });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Protection BU', slug: 'prt-' + tenantId.slice(0, 8) } });

    await ci('payments', 'business_service', 'Payments', { name: 'Payments' }, { tier: 1, rpoMinutes: 60 });
    await ci('intranet', 'business_service', 'Intranet', { name: 'Intranet' }, { tier: 3, rpoMinutes: 1440 });
    await ci('payApp', 'application', 'payments-app', { name: 'payments-app' });
    await ci('intraApp', 'application', 'intranet-app', { name: 'intranet-app' });
    await ci('payWeb', 'application_component', 'payments-web', { applicationRef: 'payments-app', name: 'web' });
    await ci('intraWeb', 'application_component', 'intranet-web', { applicationRef: 'intranet-app', name: 'web' });
    for (const n of ['01', '02', '03']) await ci('vm' + n, 'vm', 'pay-vm-' + n, { instanceUuid: randomUUID(), hypervisorRef: 'esx-prt-01', fqdn: 'pay-vm-' + n + '.prt.example' });
    await ci('vm04', 'vm', 'intra-vm-01', { instanceUuid: randomUUID(), hypervisorRef: 'esx-prt-01', fqdn: 'intra-vm-01.prt.example' });
    await ci('h1', 'host', 'db-prt-01', { serialNumber: 'PRT-H1-' + tenantId.slice(0, 6) });
    await ci('h2', 'host', 'db-prt-02', { serialNumber: 'PRT-H2-' + tenantId.slice(0, 6) });
    await ci('ledger', 'database_cluster', 'ledger-db', { engine: 'sqlserver', clusterId: 'ledger-' + tenantId.slice(0, 6) });
    await ci('archive', 'database_cluster', 'archive-db', { engine: 'postgresql', clusterId: 'archive-' + tenantId.slice(0, 6) });
    await policy('veeamJob', 'veeam', 'VBR Payments 4h', 'job', 240);
    await policy('cvPlan', 'commvault', 'Database Gold', 'plan', 60);

    await rel('part_of_service', 'payApp', 'payments');
    await rel('part_of_service', 'intraApp', 'intranet');
    await rel('contains', 'payApp', 'payWeb');
    await rel('contains', 'intraApp', 'intraWeb');
    for (const n of ['01', '02', '03']) await rel('runs_on', 'payWeb', 'vm' + n);
    await rel('runs_on', 'intraWeb', 'vm04');
    await rel('depends_on', 'payApp', 'ledger');
    await rel('depends_on', 'payApp', 'archive');
    await rel('hosted_on', 'ledger', 'h1');
    await rel('hosted_on', 'archive', 'h2');
    await rel('backed_by', 'vm01', 'veeamJob', { vendor: 'veeam', objectName: 'pay-vm-01', lastGoodBackupAt: ago(30), lastResult: 'success', restorePoints: 42 });
    await rel('backed_by', 'vm02', 'veeamJob', { vendor: 'veeam', objectName: 'pay-vm-02', lastGoodBackupAt: ago(180), lastResult: 'warning', restorePoints: 40 });
    await rel('backed_by', 'vm03', 'ledger', { kind: 'storage' });
    await rel('backed_by', 'h1', 'cvPlan', { vendor: 'commvault', objectName: 'db-prt-01', lastGoodBackupAt: ago(20), lastResult: 'success', agents: ['File System', 'SQL Server'], subclients: ['default', 'ledger'] });
    await rel('backed_by', 'h2', 'cvPlan', { vendor: 'commvault', objectName: 'db-prt-02', lastGoodBackupAt: ago(25), lastResult: 'success', agents: ['File System'] });

    await graph.upsertCis(
      graphCis.map((c) => ({ id: c.id, tenantId, type: c.type, layer: CI_TYPE_LAYER[c.type], name: c.name, displayName: c.name, lifecycle: 'discovered', health: 'healthy', tier: c.tier, validFrom: now.toISOString(), validTo: null })),
    );
    await graph.upsertRelationships(graphRels.map((r) => ({ id: r.id, tenantId, type: r.type, fromCiId: r.from, toCiId: r.to, validFrom: now.toISOString(), validTo: null })));
  }, TIMEOUT_MS);

  afterAll(async () => {
    await graph.purgeTenant(tenantId);
    await graph.close();
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.relationship.deleteMany({ where: { tenantId } });
    await prisma.ci.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('judges a VM within the service RPO protected, an older backup past it, a storage backed_by not a cover', async () => {
    const service = app.get(ProtectionService);
    const fresh = await service.ci(tenantId, id('vm01'), now);
    expect(fresh?.state).toBe('protected');
    expect(fresh?.policyRpoMinutes).toBe(240);
    expect(fresh?.targetRpoMinutes).toBe(60);
    expect(fresh?.ageMinutes).toBe(30);
    expect(fresh?.covers.map((c) => [c.policy.name, c.vendor, c.policyKind, c.restorePoints, c.via])).toEqual([['VBR Payments 4h', 'veeam', 'job', 42, null]]);
    expect(fresh?.services.map((s) => [s.service.name, s.tier, s.rpoMinutes])).toEqual([['Payments', 1, 60]]);
    const stale = await service.ci(tenantId, id('vm02'), now);
    expect(stale?.state).toBe('rpo_breached');
    expect(stale?.ageMinutes).toBe(180);
    const bare = await service.ci(tenantId, id('vm03'), now);
    expect(bare?.state).toBe('unprotected');
    expect(bare?.covers).toEqual([]);
    expect(await service.ci(tenantId, id('payments'), now)).toBeNull();
  });

  it('lets a database cluster inherit its host cover only through a database agent', async () => {
    const service = app.get(ProtectionService);
    const ledger = await service.ci(tenantId, id('ledger'), now);
    expect(ledger?.state).toBe('protected');
    expect(ledger?.covers.map((c) => [c.policy.name, c.via?.name, c.agents])).toEqual([['Database Gold', 'db-prt-01', ['File System', 'SQL Server']]]);
    const archive = await service.ci(tenantId, id('archive'), now);
    expect(archive?.state).toBe('unprotected');
    const host = await service.ci(tenantId, id('h2'), now);
    expect(host?.state).toBe('protected');
  });

  it('lists the gaps among the CIs supporting critical services, unprotected first', async () => {
    const service = app.get(ProtectionService);
    const tier2 = await service.gaps(tenantId, 2, 100, now);
    expect(tier2).toMatchObject({ maxTier: 2, criticalServices: 1, criticalCis: 7, protected: 4, rpoBreached: 1, unprotected: 2, truncated: false });
    expect(tier2.items.map((i) => [i.ci.name, i.state])).toEqual([
      ['archive-db', 'unprotected'],
      ['pay-vm-03', 'unprotected'],
      ['pay-vm-02', 'rpo_breached'],
    ]);
    const tier3 = await service.gaps(tenantId, 3, 100, now);
    expect(tier3).toMatchObject({ criticalServices: 2, criticalCis: 8, unprotected: 3 });
    expect(tier3.items.find((i) => i.ci.name === 'intra-vm-01')?.services.map((s) => s.tier)).toEqual([3]);
    const one = await service.gaps(tenantId, 2, 1, now);
    expect(one.truncated).toBe(true);
    expect(one.items).toHaveLength(1);
  });

  it('serves both through GraphQL and counts the reads', async () => {
    const card = await graphql<{ ciProtection: { state: string; targetRpoMinutes: number; covers: Array<{ policy: { name: string }; via: { name: string } | null }>; services: Array<{ tier: number; service: { name: string } }> } | null }>(
      'query($id: UUID!) { ciProtection(ciId: $id) { state targetRpoMinutes covers { policy { name } via { name } } services { tier service { name } } } }',
      { id: id('ledger') },
    );
    expect(card.errors).toEqual([]);
    expect(card.data?.ciProtection).toEqual({ state: 'protected', targetRpoMinutes: 60, covers: [{ policy: { name: 'Database Gold' }, via: { name: 'db-prt-01' } }], services: [{ tier: 1, service: { name: 'Payments' } }] });
    const gaps = await graphql<{ protectionGaps: { criticalCis: number; unprotected: number; items: Array<{ state: string; ci: { name: string } }> } }>(
      '{ protectionGaps { criticalCis unprotected items { state ci { name } } } }',
      {},
    );
    expect(gaps.errors).toEqual([]);
    expect(gaps.data?.protectionGaps.criticalCis).toBe(7);
    expect(gaps.data?.protectionGaps.items[0]).toEqual({ state: 'unprotected', ci: { name: 'archive-db' } });
    const invalid = await graphql('{ protectionGaps(maxTier: 0) { criticalCis } }', {});
    expect(invalid.errors.length).toBeGreaterThan(0);
    const metrics = await app.get(MetricsService).registry.getSingleMetricAsString(PROTECTION_METRIC);
    expect(metrics).toMatch(/query="ci"/u);
    expect(metrics).toMatch(/query="gaps"/u);
  });
});
