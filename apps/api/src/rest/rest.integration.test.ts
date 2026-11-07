// T-484 REQ-CORE-019 (ADR-049) — REST v1 through the SDK against the compose stack:
// - the OpenAPI document is public and lists every route of the table;
// - on the tenant with the most CIs, an analyst lists hosts page by page, fetches one with its relationships and
//   impact, searches it by name, and reads incidents and connectivity;
// - in a tenant of its own, an operator sets an attribute, creates a relationship and retires it, while an analyst's
//   write is refused (403) and a bad query is a 400;
// - the REST counters move by route and status (a call the role guard refuses never reaches the handler).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import { loadEnv } from '@openmap/config';
import { REST_ROUTES } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { OpenMapClient, OpenMapError } from '@openmap/sdk';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import { MetricsService } from '../metrics/metrics.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const KID = 'openmap-rest-key';
const TIMEOUT_MS = 120_000;
const PAGE = 2;
const ownTenant = randomUUID();
const organizationId = randomUUID();

let app: NestFastifyApplication;
let keys: GenerateKeyPairResult;
let baseUrl = '';
let estateTenant = '';

function token(tenant: string, roles: string[]): Promise<string> {
  return new SignJWT({ tenant, preferred_username: 'rest-user', realm_access: { roles }, azp: env.KEYCLOAK_CLIENT_ID })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject('rest-' + randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}

async function ci(name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await prisma.ci.create({
    data: {
      id, tenantId: ownTenant, type: 'host', identity: { serialNumber: 'SN-' + name }, identityKey: 'SN-' + name, name, displayName: name, code: 'REST-' + id.slice(0, 6).toUpperCase(),
      layer: 'hardware', lifecycle: 'managed', attributes: {}, tags: [], sourceCollectorId: 'test', sourceNodeId: 'test', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

describe('REST v1 and the SDK (integration)', () => {
  beforeAll(async () => {
    const populated = await prisma.ci.groupBy({ by: ['tenantId'], where: { type: 'host', validTo: null }, _count: { _all: true }, orderBy: { _count: { tenantId: 'desc' } }, take: 1 });
    estateTenant = populated[0]?.tenantId ?? '';
    expect(estateTenant).not.toBe('');
    keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [jwk] })).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    await prisma.organization.create({ data: { id: organizationId, name: 'REST org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: ownTenant, organizationId, name: 'REST BU', slug: 'rest-' + ownTenant.slice(0, 8) } });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId: ownTenant } });
    await prisma.tenant.deleteMany({ where: { id: ownTenant } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('serves the OpenAPI document without a token', async () => {
    const res = await fetch(baseUrl + '/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, Record<string, { operationId: string }>> };
    expect(doc.openapi).toBe('3.1.0');
    const operations = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(operations.sort()).toEqual(Object.keys(REST_ROUTES).sort());
    expect((await fetch(baseUrl + '/api/v1/cis')).status).toBe(401);
  });

  it('reads the estate as an analyst', async () => {
    const sdk = new OpenMapClient({ baseUrl, token: () => token(estateTenant, [ROLES.analyst]) });
    const page = await sdk.cis.list({ types: 'host', first: PAGE });
    expect(page.items).toHaveLength(PAGE);
    expect(page.totalCount).toBeGreaterThan(PAGE);
    expect(page.items.every((c) => c.type === 'host')).toBe(true);
    const next = await sdk.cis.list({ types: 'host', first: PAGE, after: page.pageInfo.endCursor ?? undefined });
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    const first = page.items[0];
    if (first === undefined) return;
    expect((await sdk.cis.get(first.id)).id).toBe(first.id);
    const rels = await sdk.cis.relationships(first.id, { direction: 'both', first: PAGE });
    expect(rels.items.every((r) => r.fromCiId === first.id || r.toCiId === first.id)).toBe(true);
    const impact = await sdk.cis.impact(first.id, { direction: 'upstream' });
    expect(impact.root.id).toBe(first.id);
    const hits = await sdk.search(first.name, { first: PAGE });
    expect(hits.length).toBeGreaterThan(0);
    expect(Array.isArray(await sdk.incidents({ open: 'false' }))).toBe(true);
    expect(Array.isArray((await sdk.connectivity()).links)).toBe(true);
    // A write needs the operator role; a malformed query is a 400.
    await expect(sdk.cis.patchAttributes(first.id, { owner: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(sdk.cis.list({ types: 'not_a_type' })).rejects.toBeInstanceOf(OpenMapError);
    await expect(sdk.cis.get(randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  it('writes as an operator in its own tenant and counts the calls', async () => {
    const a = await ci('rest-a');
    const b = await ci('rest-b');
    const sdk = new OpenMapClient({ baseUrl, token: () => token(ownTenant, [ROLES.operator]) });
    const updated = await sdk.cis.patchAttributes(a, { owner: 'DBA team' });
    expect(updated.attributes['owner']).toBe('DBA team');
    const rel = await sdk.relationships.create({ type: 'depends_on', fromCiId: a, toCiId: b });
    expect(rel).toMatchObject({ type: 'depends_on', fromCiId: a, toCiId: b, validTo: null });
    const listed = await sdk.cis.relationships(a, { direction: 'downstream' });
    expect(listed.items.map((r) => r.id)).toContain(rel.id);
    const retired = await sdk.relationships.retire(rel.id);
    expect(retired.validTo).not.toBeNull();
    const metrics = await app.get(MetricsService).registry.getSingleMetricAsString('openmap_rest_requests_total');
    expect(metrics).toContain('route="createRelationship",status="201"');
    expect(metrics).toContain('route="listCis",status="400"');
    expect(metrics).toContain('route="getCi",status="404"');
  });
});
