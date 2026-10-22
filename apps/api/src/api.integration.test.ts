// T-018 REQ-CORE-012 REQ-CMDB-001 REQ-DEP-001 REQ-CMDB-002 REQ-IPAM-001 — the Nest application against
// the compose stack: a test RS256 key stands in for Keycloak's JWKS through a provider override.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import neo4j from 'neo4j-driver';
import { loadEnv } from '@openmap/config';
import { createPrismaClient, type Prisma } from '@openmap/db';
import { createGraphRepository, type GraphCi, type GraphRelationship } from '@openmap/graph';
import { AppModule } from './app.module.js';
import { JWKS, realmUrl } from './auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from './auth/auth.service.js';
import { ROLES } from './auth/roles.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const graph = createGraphRepository(env);
const tenantId = randomUUID();
const organizationId = randomUUID();
const userId = 'user-' + randomUUID();
/** CIs are created an hour ago so that as-of reads before and after creation both have an answer. */
const createdAt = new Date(Date.now() - 3_600_000);
const KID = 'openmap-test-key';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

let app: NestFastifyApplication;
let keys: GenerateKeyPairResult;
let operatorToken: string;
let viewerToken: string;

const ids = {
  pdu: randomUUID(),
  host: randomUUID(),
  db: randomUUID(),
  app: randomUUID(),
  service: randomUUID(),
  subnet: randomUUID(),
  ip1: randomUUID(),
  ip2: randomUUID(),
};

async function mint(roles: string[], privateKey: CryptoKey): Promise<string> {
  return new SignJWT({ tenant: tenantId, preferred_username: 'tester', realm_access: { roles }, azp: env.KEYCLOAK_CLIENT_ID })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function ciRow(id: string, type: GraphCi['type'], layer: GraphCi['layer'], name: string, attributes: Record<string, unknown> = {}, identity: Record<string, string> = { name }): Prisma.CiUncheckedCreateInput {
  return {
    id,
    tenantId,
    type,
    identity,
    identityKey: Object.values(identity).join('|'),
    name,
    displayName: name,
    layer,
    lifecycle: 'managed',
    attributes: attributes as Prisma.InputJsonObject,
    tags: ['integration-test'],
    sourceCollectorId: 'test',
    sourceNodeId: 'test',
    sourceRunId: 'test',
    sourceConfidence: 0.9,
    observedAt: createdAt,
    validFrom: createdAt,
    checksum: 'a'.repeat(64),
  };
}

function relRow(type: GraphRelationship['type'], fromCiId: string, toCiId: string): Prisma.RelationshipUncheckedCreateInput {
  return { id: randomUUID(), tenantId, type, fromCiId, toCiId, attributes: {}, sourceCollectorId: 'test', sourceNodeId: 'test', sourceRunId: 'test', sourceConfidence: 0.9, observedAt: createdAt, validFrom: createdAt };
}

function graphCi(id: string, type: GraphCi['type'], layer: GraphCi['layer'], name: string, tier: number | null = null): GraphCi {
  return { id, tenantId, type, layer, name, displayName: name, lifecycle: 'managed', health: 'healthy', tier, validFrom: createdAt.toISOString(), validTo: null };
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}, token: string | null = operatorToken): Promise<GraphQLResponse<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['authorization'] = 'Bearer ' + token;
  const res = await app.inject({ method: 'POST', url: '/graphql', headers, payload: { query, variables } });
  return JSON.parse(res.body) as GraphQLResponse<T>;
}

describe('OpenMap API (integration)', () => {
  beforeAll(async () => {
    keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
    operatorToken = await mint([ROLES.operator], keys.privateKey);
    viewerToken = await mint([ROLES.analyst], keys.privateKey);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(createLocalJWKSet({ keys: [jwk] }))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    await prisma.organization.create({ data: { id: organizationId, name: 'Integration Org', industry: 'testing', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Integration BU', slug: 'it-' + tenantId.slice(0, 8) } });
    await prisma.ci.createMany({
      data: [
        ciRow(ids.pdu, 'pdu', 'dc', 'PDU-R12-B'),
        ciRow(ids.host, 'host', 'hardware', 'db-ryd-pg-core-01', { vendor: 'Dell' }),
        ciRow(ids.db, 'database_cluster', 'databases', 'Ledger DB', { redundancyGroup: 'ledger-db', minHealthy: 1 }),
        ciRow(ids.app, 'application', 'applications', 'app-ledger'),
        ciRow(ids.service, 'business_service', 'applications', 'Online banking', { tier: 1, usersAffected: 2_100_000, revenuePerHour: 1_400_000, revenueCurrency: 'SAR', slaTargetPercent: 99.95 }),
        ciRow(ids.subnet, 'subnet', 'network_security', 'core-db-net', { cidr: '10.42.0.0/29', vrf: 'prod' }),
        ciRow(ids.ip1, 'ip_address', 'network_security', '10.42.0.1', { address: '10.42.0.1' }),
        ciRow(ids.ip2, 'ip_address', 'network_security', '10.42.0.2', { address: '10.42.0.2' }),
      ],
    });
    const rels = [
      relRow('powered_by', ids.host, ids.pdu),
      relRow('runs_on', ids.db, ids.host),
      relRow('depends_on', ids.app, ids.db),
      relRow('part_of_service', ids.app, ids.service),
      relRow('part_of_service', ids.db, ids.service),
      relRow('in_subnet', ids.ip1, ids.subnet),
      relRow('in_subnet', ids.ip2, ids.subnet),
    ];
    await prisma.relationship.createMany({ data: rels });

    await graph.ensureSchema();
    await graph.upsertCis([
      graphCi(ids.pdu, 'pdu', 'dc', 'PDU-R12-B'),
      graphCi(ids.host, 'host', 'hardware', 'db-ryd-pg-core-01'),
      graphCi(ids.db, 'database_cluster', 'databases', 'Ledger DB'),
      graphCi(ids.app, 'application', 'applications', 'app-ledger'),
      graphCi(ids.service, 'business_service', 'applications', 'Online banking', 1),
      graphCi(ids.subnet, 'subnet', 'network_security', 'core-db-net'),
      graphCi(ids.ip1, 'ip_address', 'network_security', '10.42.0.1'),
      graphCi(ids.ip2, 'ip_address', 'network_security', '10.42.0.2'),
    ]);
    await graph.upsertRelationships(rels.map((r): GraphRelationship => ({ id: r.id as string, tenantId, type: r.type, fromCiId: r.fromCiId, toCiId: r.toCiId, validFrom: createdAt.toISOString(), validTo: null })));
  });

  afterAll(async () => {
    await app.close();
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
    await graph.close();
    const driver = neo4j.driver(env.MEMGRAPH_URL, neo4j.auth.basic(env.MEMGRAPH_USER, env.MEMGRAPH_PASSWORD));
    const session = driver.session();
    try {
      await session.run('MATCH (c:Ci {tenantId: $tenantId}) DETACH DELETE c', { tenantId });
    } finally {
      await session.close();
      await driver.close();
    }
  });

  it('serves liveness and readiness over REST', async () => {
    const live = await app.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    expect(JSON.parse(live.body)).toEqual({ status: 'ok' });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    const body = JSON.parse(ready.body) as { status: string; checks: Array<{ name: string; ok: boolean }> };
    expect(body.status).toBe('ready');
    expect(body.checks.map((c) => [c.name, c.ok])).toEqual([
      ['postgres', true],
      ['memgraph', true],
    ]);
  });

  it('rejects GraphQL operations without a bearer token and with a token for another client', async () => {
    const anonymous = await gql<{ layers: unknown }>('{ layers { layer } }', {}, null);
    expect(anonymous.data ?? null).toBeNull();
    expect(anonymous.errors?.[0]?.message).toMatch(/bearer token/i);
    const foreign = await new SignJWT({ tenant: tenantId, azp: 'someone-else' })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
      .setIssuer(realmUrl(env).toString())
      .setSubject(userId)
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    const res = await app.inject({ method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + foreign }, payload: { query: '{ layers { layer } }' } });
    expect(JSON.parse(res.body).errors[0].message).toMatch(/client/i);
  });

  it('pages CIs with a cursor and applies CiFilter', async () => {
    type Page = { cis: { totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean }; edges: Array<{ cursor: string; node: { id: string; name: string; type: string; health: string; source: { collectorId: string } } }> } };
    const query = 'query Cis($filter: CiFilter, $first: Int, $after: String) { cis(filter: $filter, first: $first, after: $after) { totalCount pageInfo { endCursor hasNextPage } edges { cursor node { id name type health source { collectorId } } } } }';
    const first = await gql<Page>(query, { filter: { tags: ['integration-test'] }, first: 3 });
    expect(first.errors).toBeUndefined();
    expect(first.data?.cis.totalCount).toBe(8);
    expect(first.data?.cis.edges).toHaveLength(3);
    expect(first.data?.cis.pageInfo.hasNextPage).toBe(true);
    expect(first.data?.cis.edges[0]?.node.health).toBe('healthy');
    const second = await gql<Page>(query, { filter: { tags: ['integration-test'] }, first: 10, after: first.data?.cis.pageInfo.endCursor });
    expect(second.data?.cis.edges).toHaveLength(5);
    expect(second.data?.cis.pageInfo.hasNextPage).toBe(false);
    const names = [...(first.data?.cis.edges ?? []), ...(second.data?.cis.edges ?? [])].map((e) => e.node.name);
    expect(new Set(names).size).toBe(8);
    // Pages follow the database collation (case-insensitive), which matches locale-aware ordering.
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));

    const hosts = await gql<Page>(query, { filter: { types: ['host'], attributeEquals: { vendor: 'Dell' } } });
    expect(hosts.data?.cis.edges.map((e) => e.node.id)).toEqual([ids.host]);
    const text = await gql<Page>(query, { filter: { text: 'ledger', layers: ['databases'] } });
    expect(text.data?.cis.edges.map((e) => e.node.name)).toEqual(['Ledger DB']);
    const down = await gql<Page>(query, { filter: { health: ['down'] } });
    expect(down.data?.cis.totalCount).toBe(0);
  });

  it('reads a CI as of a point in time', async () => {
    const query = 'query Ci($id: UUID!, $asOf: DateTime) { ci(id: $id, asOf: $asOf) { id name validFrom validTo } }';
    const before = await gql<{ ci: unknown }>(query, { id: ids.host, asOf: new Date(createdAt.getTime() - 60_000).toISOString() });
    expect(before.data?.ci).toBeNull();
    const now = await gql<{ ci: { id: string; validTo: string | null } }>(query, { id: ids.host, asOf: new Date().toISOString() });
    expect(now.data?.ci.id).toBe(ids.host);
    expect(now.data?.ci.validTo).toBeNull();
    const current = await gql<{ ci: { id: string } }>(query, { id: ids.host });
    expect(current.data?.ci.id).toBe(ids.host);
    const missing = await gql<{ ci: unknown }>(query, { id: randomUUID() });
    expect(missing.data?.ci).toBeNull();
  });

  it('labels a CI through the outbox and enforces the operator role', async () => {
    const mutation = 'mutation Label($input: LabelCiInput!) { labelCi(input: $input) { id layer userLabel { title layer labelledBy } } }';
    const input = { ciId: ids.host, title: 'Ledger primary', description: 'Primary Postgres node for the ledger', layer: 'databases' };
    const denied = await gql<{ labelCi: unknown }>(mutation, { input }, viewerToken);
    expect(denied.errors?.[0]?.message).toMatch(/roles/i);
    const res = await gql<{ labelCi: { id: string; layer: string; userLabel: { title: string; layer: string; labelledBy: string } } }>(mutation, { input });
    expect(res.errors).toBeUndefined();
    expect(res.data?.labelCi.layer).toBe('databases');
    expect(res.data?.labelCi.userLabel).toEqual({ title: 'Ledger primary', layer: 'databases', labelledBy: 'tester' });
    const outbox = await prisma.outboxEvent.findMany({ where: { tenantId, type: 'openmap.ci.labelled', subject: ids.host } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.pending).toContain('memgraph');
    expect(outbox[0]?.deliveredAt).toBeNull();
    const envelope = outbox[0]?.envelope as { specversion: string; tenantid: string; data: { label: { title: string } } };
    expect(envelope.specversion).toBe('1.0');
    expect(envelope.tenantid).toBe(tenantId);
    expect(envelope.data.label.title).toBe('Ledger primary');
  });

  it('creates and retires relationships through the outbox', async () => {
    const created = await gql<{ createRelationship: { id: string; type: string; from: { id: string }; to: { id: string } } }>(
      'mutation Rel($type: String!, $from: UUID!, $to: UUID!) { createRelationship(type: $type, fromCiId: $from, toCiId: $to, attributes: { note: "test" }) { id type from { id } to { id } } }',
      { type: 'located_in', from: ids.host, to: ids.pdu },
    );
    expect(created.errors).toBeUndefined();
    expect(created.data?.createRelationship.from.id).toBe(ids.host);
    const retired = await gql<{ retireRelationship: { id: string; validTo: string | null } }>('mutation Retire($id: UUID!) { retireRelationship(id: $id) { id validTo } }', { id: created.data?.createRelationship.id });
    expect(retired.data?.retireRelationship.validTo).not.toBeNull();
    const types = (await prisma.outboxEvent.findMany({ where: { tenantId, subject: created.data?.createRelationship.id } })).map((e) => e.type).sort();
    expect(types).toEqual(['openmap.relationship.created', 'openmap.relationship.retired']);
  });

  it('summarises layers from the graph and persists per-user visibility', async () => {
    type Layers = { layers: Array<{ layer: string; count: number; healthy: number; visible: boolean }> };
    const res = await gql<Layers>('{ layers { layer count healthy visible } }');
    expect(res.errors).toBeUndefined();
    expect(res.data?.layers).toHaveLength(12);
    const hardware = res.data?.layers.find((l) => l.layer === 'hardware');
    expect(hardware).toEqual({ layer: 'hardware', count: 1, healthy: 1, visible: true });
    expect(res.data?.layers.find((l) => l.layer === 'network_security')?.count).toBe(3);
    const toggled = await gql<{ setLayerVisibility: Layers['layers'] }>('mutation { setLayerVisibility(layer: hardware, visible: false) { layer visible } }');
    expect(toggled.data?.setLayerVisibility.find((l) => l.layer === 'hardware')?.visible).toBe(false);
    expect(toggled.data?.setLayerVisibility.filter((l) => l.visible)).toHaveLength(11);
    const pref = await prisma.userPreference.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
    expect(pref?.visibleLayers).not.toContain('hardware');
  });

  it('computes impact from a failed PDU up to the business service', async () => {
    type Impact = { impact: { root: { id: string }; durationMs: number; nodes: Array<{ ci: { name: string }; depth: number; predicted: string; path: string[] }>; services: Array<{ service: { name: string }; tier: number; predicted: string; usersAffected: number | null; revenueAtRiskPerHour: { amount: number; currency: string } | null; slaBudgetRemainingMinutes: number | null }> } };
    const res = await gql<Impact>('query Impact($id: UUID!) { impact(ciId: $id) { root { id } durationMs nodes { ci { name } depth predicted path } services { service { name } tier predicted usersAffected revenueAtRiskPerHour { amount currency } slaBudgetRemainingMinutes } } }', { id: ids.pdu });
    expect(res.errors).toBeUndefined();
    expect(res.data?.impact.root.id).toBe(ids.pdu);
    const names = res.data?.impact.nodes.map((n) => n.ci.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['db-ryd-pg-core-01', 'Ledger DB', 'app-ledger', 'Online banking']));
    expect(res.data?.impact.nodes.find((n) => n.ci.name === 'db-ryd-pg-core-01')).toMatchObject({ depth: 1, predicted: 'down' });
    expect(res.data?.impact.services).toHaveLength(1);
    const svc = res.data?.impact.services[0];
    expect(svc?.service.name).toBe('Online banking');
    expect(svc?.tier).toBe(1);
    // The closure (host, db, app) fails with the PDU; both modelled groups lose their only member.
    expect(svc?.predicted).toBe('down');
    expect(svc?.usersAffected).toBe(2_100_000);
    expect(svc?.revenueAtRiskPerHour).toEqual({ amount: 1_400_000, currency: 'SAR' });
    expect(svc?.slaBudgetRemainingMinutes).toBeCloseTo(21.6, 1);
  });

  it('finds the shortest path between two CIs', async () => {
    const res = await gql<{ path: Array<{ type: string; from: { name: string }; to: { name: string } }> }>('query P($a: UUID!, $b: UUID!) { path(fromCiId: $a, toCiId: $b) { type from { name } to { name } } }', { a: ids.app, b: ids.pdu });
    expect(res.errors).toBeUndefined();
    expect(res.data?.path.map((r) => r.type)).toEqual(['depends_on', 'runs_on', 'powered_by']);
  });

  it('creates a plan whose BOM becomes planned assets in one transaction', async () => {
    type Plan = { createPlan: { id: string; number: string; status: string; estimatedCost: { amount: number; currency: string } | null; bom: Array<{ description: string; quantity: number; received: number }>; assets: Array<{ id: string; assetTag: string; stage: string; manufacturer: string; model: string; purchaseCost: { amount: number; currency: string } | null }> } };
    const res = await gql<Plan>(
      'mutation Plan($input: PlanInput!) { createPlan(input: $input) { id number status estimatedCost { amount currency } bom { description quantity received } assets { id assetTag stage manufacturer model purchaseCost { amount currency } } } }',
      {
        input: {
          name: 'Ledger refresh',
          description: 'Replace the ledger database hosts',
          kind: 'refresh',
          targetSiteId: ids.pdu,
          bom: [
            { description: 'Database host', manufacturer: 'Dell', model: 'R760', sku: 'R760-2S', layer: 'hardware', quantity: 2, unitCostAmount: 45_000, unitCostCurrency: 'SAR' },
            { description: 'Top-of-rack switch', manufacturer: 'Arista', model: '7050X3', layer: 'network_security', quantity: 1, unitCostAmount: 30_000, unitCostCurrency: 'SAR' },
          ],
        },
      },
    );
    expect(res.errors).toBeUndefined();
    const plan = res.data?.createPlan;
    expect(plan?.number).toMatch(/^PLAN-\d+$/);
    expect(plan?.status).toBe('draft');
    expect(plan?.estimatedCost).toEqual({ amount: 120_000, currency: 'SAR' });
    expect(plan?.bom.map((l) => [l.quantity, l.received])).toEqual([
      [2, 0],
      [1, 0],
    ]);
    expect(plan?.assets).toHaveLength(3);
    expect(plan?.assets.every((a) => a.stage === 'planned')).toBe(true);
    expect(plan?.assets.map((a) => a.assetTag).sort()).toEqual([plan?.number + '-1-1', plan?.number + '-1-2', plan?.number + '-2-1']);
    expect(plan?.assets.find((a) => a.assetTag.endsWith('-2-1'))).toMatchObject({ manufacturer: 'Arista', model: '7050X3', purchaseCost: { amount: 30_000, currency: 'SAR' } });
    const audits = await prisma.assetAudit.count({ where: { tenantId, asset: { planId: plan?.id } } });
    expect(audits).toBe(3);
    const events = await prisma.outboxEvent.findMany({ where: { tenantId, type: 'openmap.asset.stage.changed' } });
    expect(events).toHaveLength(3);

    const staged = await gql<{ setAssetStage: { stage: string } }>('mutation S($id: UUID!) { setAssetStage(assetId: $id, stage: in_stock, note: "received") { stage } }', { id: plan?.assets[0]?.id });
    expect(staged.data?.setAssetStage.stage).toBe('in_stock');
    const approved = await gql<{ setPlanStatus: { status: string } }>('mutation A($id: UUID!) { setPlanStatus(planId: $id, status: approved) { status } }', { id: plan?.id });
    expect(approved.data?.setPlanStatus.status).toBe('approved');
    const listed = await gql<{ assets: Array<{ assetTag: string }>; plans: Array<{ number: string }> }>('{ assets(stage: [in_stock]) { assetTag } plans(status: [approved]) { number } }');
    expect(listed.data?.assets).toHaveLength(1);
    expect(listed.data?.plans.map((p) => p.number)).toEqual([plan?.number]);
  });

  it('builds the subnet tree, utilisation and the next free address from stored CIs', async () => {
    type Subnets = { subnets: Array<{ cidr: string; vrf: string | null; utilisationPercent: number; children: unknown[]; addresses: { totalCount: number; edges: Array<{ node: { name: string } }> } }>; nextFreeIp: string | null };
    const res = await gql<Subnets>('query N($id: UUID!) { subnets { cidr vrf utilisationPercent children { cidr } addresses(first: 10) { totalCount edges { node { name } } } } nextFreeIp(subnetId: $id) }', { id: ids.subnet });
    expect(res.errors).toBeUndefined();
    expect(res.data?.subnets).toHaveLength(1);
    const subnet = res.data?.subnets[0];
    expect(subnet).toMatchObject({ cidr: '10.42.0.0/29', vrf: 'prod', children: [] });
    expect(subnet?.utilisationPercent).toBeCloseTo((2 / 6) * 100, 5);
    expect(subnet?.addresses.totalCount).toBe(2);
    expect(res.data?.nextFreeIp).toBe('10.42.0.3');
  });

  it('exposes Prometheus metrics for the GraphQL operations served', async () => {
    const res = await app.inject({ method: 'GET', url: env.METRICS_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('openmap_graphql_requests_total{operation="Cis",status="ok"}');
    expect(res.body).toContain('openmap_graphql_requests_total{operation="Label",status="error"}');
    expect(res.body).toContain('openmap_graphql_duration_seconds_bucket');
    expect(res.body).toContain('process_cpu_user_seconds_total');
  });
});
