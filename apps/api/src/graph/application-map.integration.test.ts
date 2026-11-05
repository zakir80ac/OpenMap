// T-158 REQ-DEP-004 (ADR-031) — the layered application map through GraphQL against the compose stack, for the tenant
// with the most applications (the synthetic estate): an application comes back with its business services, its tiers
// in catalogue order, every component placed on what it runs on and what that runs on, and its dependencies classified
// internal, outbound and inbound with the derived ones carrying their evidence; a non-application id maps to null.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const KID = 'openmap-appmap-key';
const TIMEOUT_MS = 120_000;

interface Dep {
  direction: string;
  derived: boolean;
  type: string;
  ports: number[];
  flows: number | null;
  confidence: number;
  otherApplication: { name: string } | null;
  from: { name: string };
  to: { name: string };
}
interface AppMap {
  application: { id: string; name: string };
  services: Array<{ type: string }>;
  tiers: Array<{ tier: string; components: Array<{ tier: string; port: number | null; ci: { id: string; type: string } }> }>;
  placements: Array<{ parentId: string; relationship: string; hop: number; ci: { id: string; type: string; layer: string } }>;
  dependencies: Dep[];
  truncated: boolean;
  durationMs: number;
}

const QUERY =
  'query A($id: UUID!) { applicationMap(id: $id) { truncated durationMs application { id name } services { type } tiers { tier components { tier port ci { id type } } } placements { parentId relationship hop ci { id type layer } } dependencies { direction derived type ports flows confidence otherApplication { name } from { name } to { name } } } }';

let app: NestFastifyApplication;
let token = '';
let tenantId = '';

async function appMap(id: string): Promise<AppMap | null> {
  const res = await app.inject({ method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, payload: { query: QUERY, variables: { id } } });
  const body = JSON.parse(res.body) as { data?: { applicationMap: AppMap | null } | null; errors?: Array<{ message: string }> };
  if (body.data === undefined || body.data === null) throw new Error(body.errors?.[0]?.message ?? 'no data');
  return body.data.applicationMap;
}

describe('layered application map (integration)', () => {
  beforeAll(async () => {
    const populated = await prisma.ci.groupBy({ by: ['tenantId'], where: { type: 'application', validTo: null }, _count: { _all: true }, orderBy: { _count: { tenantId: 'desc' } }, take: 1 });
    tenantId = populated[0]?.tenantId ?? '';
    expect(tenantId, 'a tenant with applications').not.toBe('');
    const keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    token = await new SignJWT({ tenant: tenantId, preferred_username: 'appmap', realm_access: { roles: [ROLES.analyst] }, azp: env.KEYCLOAK_CLIENT_ID })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
      .setIssuer(realmUrl(env).toString())
      .setSubject('appmap-' + randomUUID())
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [jwk] })).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  });

  it('maps an application with tiers, placements and classified dependencies', async () => {
    // The application whose components carry the most derived dependencies: a web, api and db tier talking to each other.
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT a.id FROM cis a
      JOIN relationships c ON c."fromCiId" = a.id AND c.type = 'contains' AND c."validTo" IS NULL
      JOIN relationships d ON d."fromCiId" = c."toCiId" AND d.type = 'depends_on' AND d."sourceCollectorId" = 'adm' AND d."validTo" IS NULL
      WHERE a."tenantId" = ${tenantId}::uuid AND a.type = 'application' AND a."validTo" IS NULL
      GROUP BY a.id ORDER BY count(*) DESC, a.id LIMIT 1`;
    const id = rows[0]?.id ?? '';
    expect(id).not.toBe('');
    const map = await appMap(id);
    expect(map?.application.id).toBe(id);
    expect(map?.truncated).toBe(false);
    expect(map?.services.every((s) => s.type === 'business_service')).toBe(true);
    const tiers = map?.tiers.map((t) => t.tier) ?? [];
    expect(tiers.length).toBeGreaterThan(1);
    if (tiers.includes('web') && tiers.includes('db')) expect(tiers.indexOf('web')).toBeLessThan(tiers.indexOf('db'));
    const componentIds = new Set(map?.tiers.flatMap((t) => t.components.map((c) => c.ci.id)) ?? []);
    const direct = map?.placements.filter((p) => p.hop === 1) ?? [];
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.every((p) => componentIds.has(p.parentId))).toBe(true);
    expect(map?.placements.some((p) => p.hop > 1)).toBe(true);
    const deps = map?.dependencies ?? [];
    expect(deps.some((d) => d.direction === 'internal' && d.derived && d.ports.length > 0 && (d.flows ?? 0) > 0)).toBe(true);
    expect(deps.every((d) => d.confidence > 0 && d.confidence <= 1)).toBe(true);
    expect(deps.filter((d) => d.direction !== 'internal').every((d) => d.otherApplication === null || d.otherApplication.name.length > 0)).toBe(true);
  }, TIMEOUT_MS);

  it('returns null for an id that is not an application', async () => {
    const host = await prisma.ci.findFirst({ where: { tenantId, type: 'host', validTo: null }, select: { id: true } });
    expect(await appMap(host?.id ?? '00000000-0000-4000-8000-000000000000')).toBeNull();
  }, TIMEOUT_MS);
});
