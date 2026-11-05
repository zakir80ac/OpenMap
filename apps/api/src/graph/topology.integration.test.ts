// T-154 REQ-DEP-001 (ADR-030) — network topology through GraphQL against the compose stack, for the tenant with the
// most network devices (the synthetic estate): the L2 map joins devices by their LLDP neighbour links with interface
// pairs and speeds; with hosts it attaches servers to their top-of-rack ports; a site narrows the map to the devices
// located there; the L3 map joins devices to subnets through their addresses; an analyst may read it.
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
const KID = 'openmap-topology-key';
const TIMEOUT_MS = 120_000;

interface Link {
  kind: string;
  count: number;
  ports: string[];
  protocols: string[];
  speedMbps: number | null;
  from: { id: string; type: string; name: string };
  to: { id: string; type: string; name: string };
}
interface Topology {
  layer: string;
  truncated: boolean;
  durationMs: number;
  nodes: Array<{ degree: number; ci: { id: string; type: string; name: string } }>;
  links: Link[];
}

const QUERY =
  'query T($layer: TopologyLayer, $siteId: UUID, $includeHosts: Boolean) { networkTopology(layer: $layer, siteId: $siteId, includeHosts: $includeHosts) { layer truncated durationMs nodes { degree ci { id type name } } links { kind count ports protocols speedMbps from { id type name } to { id type name } } } }';

let app: NestFastifyApplication;
let token = '';
let tenantId = '';

async function topology(variables: Record<string, unknown>): Promise<Topology> {
  const res = await app.inject({ method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, payload: { query: QUERY, variables } });
  const body = JSON.parse(res.body) as { data?: { networkTopology: Topology } | null; errors?: Array<{ message: string }> };
  if (body.data === undefined || body.data === null) throw new Error(body.errors?.[0]?.message ?? 'no data');
  return body.data.networkTopology;
}

describe('network topology (integration)', () => {
  beforeAll(async () => {
    const populated = await prisma.ci.groupBy({ by: ['tenantId'], where: { type: 'network_device', validTo: null }, _count: { _all: true }, orderBy: { _count: { tenantId: 'desc' } }, take: 1 });
    tenantId = populated[0]?.tenantId ?? '';
    expect(tenantId, 'a tenant with network devices').not.toBe('');
    const keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    token = await new SignJWT({ tenant: tenantId, preferred_username: 'topology', realm_access: { roles: [ROLES.analyst] }, azp: env.KEYCLOAK_CLIENT_ID })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
      .setIssuer(realmUrl(env).toString())
      .setSubject('topology-' + randomUUID())
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

  it('draws the L2 map from neighbour links, and attaches hosts on request', async () => {
    const l2 = await topology({ layer: 'l2' });
    expect(l2.layer).toBe('l2');
    expect(l2.links.length).toBeGreaterThan(0);
    expect(l2.links.every((l) => l.kind === 'neighbour')).toBe(true);
    const link = l2.links[0];
    expect(link?.ports[0]).toContain('↔');
    expect(link?.protocols).toContain('lldp');
    expect(link?.speedMbps).toBeGreaterThan(0);
    expect(l2.nodes.every((n) => n.ci.type === 'network_device' || n.ci.type === 'load_balancer')).toBe(true);
    const withHosts = await topology({ layer: 'l2', includeHosts: true });
    const hostLinks = withHosts.links.filter((l) => l.kind === 'host');
    expect(hostLinks.length).toBeGreaterThan(0);
    expect(hostLinks[0]?.ports[0]).toContain('→');
    expect(withHosts.nodes.length).toBeGreaterThan(l2.nodes.length);
  }, TIMEOUT_MS);

  it('narrows the map to a site and draws L3 through subnets', async () => {
    const site = await prisma.$queryRaw<Array<{ site: string; n: bigint }>>`
      SELECT r."toCiId" AS site, count(*) AS n FROM relationships r JOIN cis s ON s.id = r."toCiId" AND s.type = 'site'
      WHERE r."tenantId" = ${tenantId}::uuid AND r.type = 'located_in' AND r."validTo" IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`;
    const siteId = site[0]?.site ?? null;
    const all = await topology({ layer: 'l2' });
    if (siteId !== null) {
      const scoped = await topology({ layer: 'l2', siteId });
      expect(scoped.nodes.length).toBeGreaterThan(0);
      expect(scoped.nodes.length).toBeLessThanOrEqual(all.nodes.length);
    }
    const l3 = await topology({ layer: 'l3' });
    expect(l3.links.length).toBeGreaterThan(0);
    expect(l3.links.every((l) => l.kind === 'subnet' && l.to.type === 'subnet')).toBe(true);
    expect(l3.nodes.some((n) => n.ci.type === 'subnet')).toBe(true);
  }, TIMEOUT_MS);
});
