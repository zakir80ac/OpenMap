// T-602 REQ-SEC-012 (ADR-070) — compliance posture against the compose stack, in a tenant of its own whose estate
// carries one fact of every family the checks read:
// - host A runs software affected by a critical, exploited CVE; its OS (Ubuntu 18.04, ended in the bundled lifecycle
//   catalogue) was last patched long ago; host B runs clean software on Ubuntu 24.04, patched, but its hardware is
//   past end of support in the asset register;
// - an expired certificate with a 1024-bit key, a TLS 1.0 listener, an unencrypted public bucket, an encrypted
//   database cluster, an unencrypted SMB share, a fresh and a stale database backup, a firewall with a permissive rule;
// - the evaluation stores a decision per check and subject with its facts, the posture's pass rate is
//   passed / (passed + failed), host A is the one high-risk CI, and a control's findings list it first, flagged;
// - over GraphQL an analyst reads the posture but may not run an evaluation; an auditor may.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { LIFECYCLE, TIME } from '@openmap/constants';
import { CI_TYPE_LAYER, type CiType, type RelationshipType } from '@openmap/contracts';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import { ComplianceService } from './compliance.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 180_000;
const KID = 'openmap-compliance-key';
const organizationId = randomUUID();
const tenantId = randomUUID();
const stamp = tenantId.slice(0, 8);
let app: NestFastifyApplication;
let privateKey: KeyLike;
const ids: Record<string, string> = {};
const now = Date.now();
const ago = (ms: number): string => new Date(now - ms).toISOString();

async function ci(key: string, type: CiType, attributes: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const at = new Date();
  const name = key + '-' + stamp;
  await prisma.ci.create({
    data: {
      id, tenantId, type, identity: { name }, identityKey: name, name, displayName: name, code: 'CMP-' + id.slice(0, 8).toUpperCase(),
      layer: CI_TYPE_LAYER[type], lifecycle: 'discovered', attributes: attributes as object, tags: [], sourceCollectorId: 'itest', sourceNodeId: 'itest',
      sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: at, validFrom: at, checksum: 'c'.repeat(64),
    },
  });
  ids[key] = id;
  return id;
}

async function rel(type: RelationshipType, from: string, to: string): Promise<void> {
  const at = new Date();
  await prisma.relationship.create({ data: { id: randomUUID(), tenantId, type, fromCiId: ids[from] ?? '', toCiId: ids[to] ?? '', attributes: {}, sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: at, validFrom: at } });
}

async function token(role: string): Promise<string> {
  return new SignJWT({ tenant: tenantId, preferred_username: 'compliance-' + role, realm_access: { roles: [role] }, azp: env.KEYCLOAK_CLIENT_ID })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject('compliance-' + randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

async function gql(role: string, query: string): Promise<GqlResult> {
  const res = await app.inject({ method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await token(role)) }, payload: { query } });
  return JSON.parse(res.body) as GqlResult;
}

describe('compliance posture (integration)', () => {
  beforeAll(async () => {
    // The estate is written before the API starts: its start opens a burst of connections, and Docker Desktop's port
    // forwarding drops new connections during such a burst.
    await prisma.$connect();
    await prisma.organization.create({ data: { id: organizationId, name: 'Compliance org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Compliance BU', slug: 'compliance-' + stamp } });

    await ci('hostA', 'host', {});
    await ci('hostB', 'host', {});
    await ci('openssl', 'software', { vendor: 'OpenSSL', version: '1.0.2' });
    await ci('nginx', 'software', { vendor: 'F5', version: '1.27.0' });
    await ci('opensslA', 'software_instance', {});
    await ci('nginxB', 'software_instance', {});
    await ci('cve', 'vulnerability', { cveId: 'CVE-2099-0001', severity: 'critical', cvssScore: 9.8, exploitedInWild: true });
    await rel('member_of', 'opensslA', 'openssl');
    await rel('installed_on', 'opensslA', 'hostA');
    await rel('member_of', 'nginxB', 'nginx');
    await rel('installed_on', 'nginxB', 'hostB');
    await rel('affected_by', 'openssl', 'cve');
    await ci('osA', 'operating_system', { name: 'Ubuntu', version: '18.04', lastPatchedAt: ago((LIFECYCLE.patchStaleDays + 30) * TIME.msPerDay) });
    await ci('osB', 'operating_system', { name: 'Ubuntu', version: '24.04', lastPatchedAt: ago(TIME.msPerDay) });
    await rel('installed_on', 'osA', 'hostA');
    await rel('installed_on', 'osB', 'hostB');
    await prisma.assetRecord.create({
      data: {
        tenantId, ciId: ids['hostB'] ?? '', ciType: 'host', layer: 'hardware', source: 'discovery', assetTag: 'CMP-' + stamp, stage: 'deployed', stageChangedAt: new Date(),
        depreciationMethod: 'none', usefulLifeMonths: 60, residualValueAmount: 0, residualValueCurrency: 'SAR', tags: [], customFields: {},
        endOfLife: { endOfSale: null, endOfSoftwareMaintenance: null, endOfSupport: '2025-01-31', source: 'itest', verifiedAt: null },
      },
    });
    await ci('cert', 'certificate', { subject: 'CN=portal-' + stamp, notAfter: ago(TIME.msPerDay * 3), keyAlgorithm: 'RSA', keyBits: 1024, signatureAlgorithm: 'SHA256-RSA', isCa: false });
    await ci('tls10', 'listening_service', { protocol: 'tcp', port: 443, tls: true, tlsVersion: 'TLS 1.0', serverName: 'portal-' + stamp });
    await ci('bucket', 'object_bucket', { encryption: 'none', publicAccessBlocked: false });
    await ci('cluster', 'database_cluster', { encryptionAtRest: true });
    await ci('share', 'nas_share', { protocol: 'smb', options: [] });
    await ci('dbFresh', 'database', { lastBackupAt: ago(TIME.msPerHour) });
    await ci('dbStale', 'database', { lastBackupAt: ago(TIME.msPerDay * 3) });
    await ci('fw', 'network_device', {});
    await ci('anyAny', 'firewall_rule', { ruleId: '1', chain: 'forward', action: 'allow', source: 'any', destination: 'any', service: 'any', position: 1 });
    await rel('contains', 'fw', 'anyAny');

    const pair = await generateKeyPair(SIGNING_ALGORITHM);
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: SIGNING_ALGORITHM };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(createLocalJWKSet({ keys: [jwk] }))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.complianceRun.deleteMany({ where: { tenantId } });
    await prisma.assetRecord.deleteMany({ where: { tenantId } });
    await prisma.relationship.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('stores a decision per check with its facts and computes each framework from them', async () => {
    const service = app.get(ComplianceService);
    const before = await service.posture(tenantId);
    expect(before.run).toBeNull();
    expect(before.frameworks).toEqual([]);

    const posture = await service.evaluate(tenantId, 'itest');
    expect(posture.run?.triggeredBy).toBe('itest');
    expect(posture.frameworks.map((f) => f.framework)).toEqual(['soc2', 'iso27001', 'pci_dss', 'sama_csf', 'nca_ecc']);
    expect(posture.cveRisk).toEqual({ critical: 1, high: 0, exploited: 1, exposedCis: 1 });

    const rows = await prisma.complianceResult.findMany({ where: { runId: posture.run?.id ?? '' } });
    const decision = (check: string, key: string | null) => rows.find((r) => r.check === check && r.ciId === (key === null ? null : (ids[key] ?? '')));
    expect(decision('cve_high_critical', 'hostA')).toMatchObject({ result: 'fail', reason: 'high_cve', highRisk: true, facts: { worstCve: 'CVE-2099-0001', critical: 1 } });
    expect(decision('cve_high_critical', 'hostB')).toMatchObject({ result: 'pass', highRisk: false });
    expect(decision('cve_exploited', 'hostA')?.result).toBe('fail');
    expect(decision('release_supported', 'osA')).toMatchObject({ result: 'fail', reason: 'release_ended', highRisk: true });
    expect(decision('release_supported', 'osB')?.result).toBe('pass');
    expect(decision('os_patched', 'osA')).toMatchObject({ result: 'fail', highRisk: true });
    expect(decision('os_patched', 'osB')?.result).toBe('pass');
    expect(decision('hardware_supported', 'hostB')).toMatchObject({ result: 'fail', reason: 'hardware_ended', highRisk: false });
    expect(decision('certificate_valid', 'cert')?.result).toBe('fail');
    expect(decision('certificate_strong', 'cert')?.result).toBe('fail');
    expect(decision('tls_modern', 'tls10')).toMatchObject({ result: 'fail', facts: { tlsVersion: 'TLS 1.0' } });
    expect(decision('storage_encrypted', 'bucket')?.result).toBe('fail');
    expect(decision('storage_encrypted', 'cluster')?.result).toBe('pass');
    expect(decision('bucket_public_blocked', 'bucket')?.result).toBe('fail');
    expect(decision('share_encrypted', 'share')?.result).toBe('fail');
    expect(decision('database_backup_recent', 'dbFresh')?.result).toBe('pass');
    expect(decision('database_backup_recent', 'dbStale')?.result).toBe('fail');
    expect(decision('firewall_no_permissive', 'fw')).toMatchObject({ result: 'fail', facts: { permissive: 1 } });
    expect(decision('platform_backup_recent', null)).toBeDefined();

    for (const f of posture.frameworks) {
      const decided = f.evaluations.passed + f.evaluations.failed;
      expect(f.passRate).toBeCloseTo(f.evaluations.passed / decided);
      expect(f.highRiskCis).toBe(1);
    }
    const pci = posture.frameworks.find((f) => f.framework === 'pci_dss');
    expect(pci?.controls.find((c) => c.controlId === '11.3.1')).toMatchObject({ result: 'fail', tally: { passed: 1, failed: 1, notApplicable: 0 } });

    const control = await service.control(tenantId, 'pci_dss', '12.3.4', 'fail', 10);
    expect(control.findings.map((f) => f.ciId)).toEqual([ids['osA'], ids['hostB']]);
    expect(control.findings[0]).toMatchObject({ highRisk: true, reason: 'release_ended' });
    expect(control.findings[0]?.facts).toContainEqual({ key: 'release', value: expect.stringContaining('18.04') as string });
  }, TIMEOUT_MS);

  it('lets analysts read and operators or auditors evaluate over GraphQL', async () => {
    const read = await gql(ROLES.analyst, '{ compliancePosture { run { id catalogueVersion } frameworks { framework passRate highRiskCis controls { controlId result } } cveRisk { critical } } }');
    expect(read.errors).toBeUndefined();
    expect((read.data?.['compliancePosture'] as { frameworks: unknown[] }).frameworks).toHaveLength(5);
    const denied = await gql(ROLES.analyst, 'mutation { evaluateCompliance { run { id } } }');
    expect(denied.errors?.[0]?.message).toMatch(/role|forbidden/i);
    const audited = await gql(ROLES.auditor, 'mutation { evaluateCompliance { run { id triggeredBy } } }');
    expect(audited.errors).toBeUndefined();
    expect((audited.data?.['evaluateCompliance'] as { run: { triggeredBy: string } }).run.triggeredBy).toBe('compliance-' + ROLES.auditor);
    const detail = await gql(ROLES.analyst, '{ complianceControl(framework: iso27001, controlId: "A.8.8") { result truncated findings { check highRisk reason ci { id } facts { key value } } } }');
    expect(detail.errors).toBeUndefined();
    const findings = (detail.data?.['complianceControl'] as { findings: Array<{ highRisk: boolean; ci: { id: string } | null }> }).findings;
    expect(findings[0]?.highRisk).toBe(true);
    expect([ids['hostA'], ids['osA']]).toContain(findings[0]?.ci?.id);
    const unknown = await gql(ROLES.analyst, '{ complianceControl(framework: iso27001, controlId: "Z.9") { result } }');
    expect(unknown.errors?.[0]?.message).toMatch(/unknown control/);
  }, TIMEOUT_MS);
});
