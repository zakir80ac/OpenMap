// T-032 REQ-CORE-012 REQ-CMDB-001 REQ-DEP-001 REQ-CMDB-002 REQ-IPAM-001 — the Nest application against
// the compose stack: a test RS256 key stands in for Keycloak's JWKS through a provider override.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import neo4j from 'neo4j-driver';
import { loadEnv, TENANT_SETTINGS_DEFAULTS, type TenantSettings } from '@openmap/config';
import { TIME } from '@openmap/constants';
import { bookValue } from '@openmap/contracts';
import { createPrismaClient, type Prisma } from '@openmap/db';
import { createGraphRepository, type GraphCi, type GraphRelationship } from '@openmap/graph';
import { AppModule } from './app.module.js';
import { ClickHouseService } from './db/clickhouse.service.js';
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
  software: randomUUID(),
  instance: randomUUID(),
  licence: randomUUID(),
  vuln: randomUUID(),
};

async function mint(
  roles: string[],
  privateKey: CryptoKey,
  client: { azp: string; aud?: string[] } = { azp: env.KEYCLOAK_CLIENT_ID },
): Promise<string> {
  return new SignJWT({
    tenant: tenantId,
    preferred_username: 'tester',
    realm_access: { roles },
    azp: client.azp,
    ...(client.aud === undefined ? {} : { aud: client.aud }),
  })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function ciRow(
  id: string,
  type: GraphCi['type'],
  layer: GraphCi['layer'],
  name: string,
  attributes: Record<string, unknown> = {},
  identity: Record<string, string> = { name },
): Prisma.CiUncheckedCreateInput {
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

function relRow(
  type: GraphRelationship['type'],
  fromCiId: string,
  toCiId: string,
): Prisma.RelationshipUncheckedCreateInput {
  return {
    id: randomUUID(),
    tenantId,
    type,
    fromCiId,
    toCiId,
    attributes: {},
    sourceCollectorId: 'test',
    sourceNodeId: 'test',
    sourceRunId: 'test',
    sourceConfidence: 0.9,
    observedAt: createdAt,
    validFrom: createdAt,
  };
}

function graphCi(
  id: string,
  type: GraphCi['type'],
  layer: GraphCi['layer'],
  name: string,
  tier: number | null = null,
): GraphCi {
  return {
    id,
    tenantId,
    type,
    layer,
    name,
    displayName: name,
    lifecycle: 'managed',
    health: 'healthy',
    tier,
    validFrom: createdAt.toISOString(),
    validTo: null,
  };
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  token: string | null = operatorToken,
): Promise<GraphQLResponse<T>> {
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
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: ['error', 'warn'],
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Integration Org',
        industry: 'testing',
        timeZone: 'UTC',
        defaultLocale: 'en',
        regulatoryScope: [],
        airGapped: true,
      },
    });
    await prisma.tenant.create({
      data: { id: tenantId, organizationId, name: 'Integration BU', slug: 'it-' + tenantId.slice(0, 8) },
    });
    await prisma.ci.createMany({
      data: [
        ciRow(ids.pdu, 'pdu', 'dc', 'PDU-R12-B'),
        ciRow(ids.host, 'host', 'hardware', 'db-ryd-pg-core-01', { vendor: 'Dell' }),
        ciRow(ids.db, 'database_cluster', 'databases', 'Ledger DB', {
          redundancyGroup: 'ledger-db',
          minHealthy: 1,
        }),
        ciRow(ids.app, 'application', 'applications', 'app-ledger'),
        ciRow(ids.service, 'business_service', 'applications', 'Online banking', {
          tier: 1,
          usersAffected: 2_100_000,
          revenuePerHour: 1_400_000,
          revenueCurrency: 'SAR',
          slaTargetPercent: 99.95,
        }),
        ciRow(ids.subnet, 'subnet', 'network_security', 'core-db-net', { cidr: '10.42.0.0/29', vrf: 'prod' }),
        ciRow(ids.ip1, 'ip_address', 'network_security', '10.42.0.1', { address: '10.42.0.1' }),
        ciRow(ids.ip2, 'ip_address', 'network_security', '10.42.0.2', { address: '10.42.0.2' }),
        ciRow(
          ids.software,
          'software',
          'applications',
          'PostgreSQL 16.4',
          { category: 'database', licensed: true },
          { vendor: 'PostgreSQL', name: 'PostgreSQL', version: '16.4' },
        ),
        ciRow(
          ids.instance,
          'software_instance',
          'applications',
          'PostgreSQL 16.4 on db-ryd-pg-core-01',
          { running: true, version: '16.4' },
          {
            hostRef: ids.host,
            softwareRef: 'PostgreSQL/PostgreSQL/16.4',
            installPath: '/usr/lib/postgresql/16',
          },
        ),
        ciRow(
          ids.licence,
          'licence',
          'applications',
          'PostgreSQL support licence',
          {
            metric: 'core',
            licenceType: 'subscription',
            entitlement: 32,
            consumed: 40,
            overDeployed: true,
            expiresAt: '2027-01-01',
            expired: false,
            annualCost: 12000,
            currency: 'SAR',
          },
          { softwareRef: 'PostgreSQL/PostgreSQL/16.4', licenceKeyDigest: 'f'.repeat(64) },
        ),
        ciRow(
          ids.vuln,
          'vulnerability',
          'applications',
          'CVE-2026-0001',
          {
            cveId: 'CVE-2026-0001',
            title: 'PostgreSQL remote code execution',
            severity: 'critical',
            cvssScore: 9.8,
            exploitedInWild: true,
            cisaKev: true,
            patchAvailable: true,
            publishedAt: '2026-01-10T00:00:00.000Z',
          },
          { cveId: 'CVE-2026-0001' },
        ),
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
      relRow('member_of', ids.instance, ids.software),
      relRow('installed_on', ids.instance, ids.host),
      relRow('licensed_by', ids.software, ids.licence),
      relRow('affected_by', ids.software, ids.vuln),
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
    await graph.upsertRelationships(
      rels.map((r): GraphRelationship => ({
        id: r.id as string,
        tenantId,
        type: r.type,
        fromCiId: r.fromCiId,
        toCiId: r.toCiId,
        validFrom: createdAt.toISOString(),
        validTo: null,
      })),
    );
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
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + foreign },
      payload: { query: '{ layers { layer } }' },
    });
    expect(JSON.parse(res.body).errors[0].message).toMatch(/client/i);
  });

  it('accepts a service-account token addressed to the API client and refuses one from a foreign client', async () => {
    const automation = await mint([ROLES.operator], keys.privateKey, {
      azp: 'openmap-automation',
      aud: [env.KEYCLOAK_API_CLIENT_ID],
    });
    const ok = await gql<{ layers: unknown[] }>('query { layers { layer } }', {}, automation);
    expect(ok.errors).toBeUndefined();
    expect(Array.isArray(ok.data?.layers)).toBe(true);

    const foreign = await mint([ROLES.operator], keys.privateKey, {
      azp: 'some-other-app',
      aud: ['some-other-api'],
    });
    const denied = await gql<{ layers: unknown[] }>('query { layers { layer } }', {}, foreign);
    expect(denied.errors?.[0]?.message).toContain('not issued for this client');
  });

  it('pages CIs with a cursor and applies CiFilter', async () => {
    type Page = {
      cis: {
        totalCount: number;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
        edges: Array<{
          cursor: string;
          node: { id: string; name: string; type: string; health: string; source: { collectorId: string } };
        }>;
      };
    };
    const query =
      'query Cis($filter: CiFilter, $first: Int, $after: String) { cis(filter: $filter, first: $first, after: $after) { totalCount pageInfo { endCursor hasNextPage } edges { cursor node { id name type health source { collectorId } } } } }';
    const first = await gql<Page>(query, { filter: { tags: ['integration-test'] }, first: 3 });
    expect(first.errors).toBeUndefined();
    expect(first.data?.cis.totalCount).toBe(12);
    expect(first.data?.cis.edges).toHaveLength(3);
    expect(first.data?.cis.pageInfo.hasNextPage).toBe(true);
    expect(first.data?.cis.edges[0]?.node.health).toBe('healthy');
    const second = await gql<Page>(query, {
      filter: { tags: ['integration-test'] },
      first: 10,
      after: first.data?.cis.pageInfo.endCursor,
    });
    expect(second.data?.cis.edges).toHaveLength(9);
    expect(second.data?.cis.pageInfo.hasNextPage).toBe(false);
    const names = [...(first.data?.cis.edges ?? []), ...(second.data?.cis.edges ?? [])].map(
      (e) => e.node.name,
    );
    expect(new Set(names).size).toBe(12);
    // Pages follow the database collation (case-insensitive), which matches locale-aware ordering.
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));

    const hosts = await gql<Page>(query, {
      filter: { types: ['host'], attributeEquals: { vendor: 'Dell' } },
    });
    expect(hosts.data?.cis.edges.map((e) => e.node.id)).toEqual([ids.host]);
    const text = await gql<Page>(query, { filter: { text: 'ledger', layers: ['databases'] } });
    expect(text.data?.cis.edges.map((e) => e.node.name)).toEqual(['Ledger DB']);
    const down = await gql<Page>(query, { filter: { health: ['down'] } });
    expect(down.data?.cis.totalCount).toBe(0);
  });

  it('serves the layer headline metric from the latest ClickHouse sample, null until sampled, days since seen for unknown CIs (REQ-CMDB-038)', async () => {
    type Headline = {
      ci: {
        layer: string;
        headlineMetric: {
          key: string;
          label: string;
          unit: string;
          metric: string;
          value: number | null;
          observedAt: string | null;
        };
      } | null;
    };
    const query =
      'query Headline($id: UUID!) { ci(id: $id) { layer headlineMetric { key label unit metric value observedAt } } }';
    const clickhouse = app.get(ClickHouseService);
    const older = '2026-10-22 08:00:00.000';
    const latest = '2026-10-22 09:30:00.000';
    await clickhouse.insert('metrics', [
      {
        tenant_id: tenantId,
        ci_id: ids.host,
        metric: 'host.cpu.utilisation_percent',
        ts: older,
        value: 12,
        unit: 'percent',
        labels: {},
        source_run_id: randomUUID(),
      },
      {
        tenant_id: tenantId,
        ci_id: ids.host,
        metric: 'host.cpu.utilisation_percent',
        ts: latest,
        value: 41.5,
        unit: 'percent',
        labels: {},
        source_run_id: randomUUID(),
      },
      {
        tenant_id: tenantId,
        ci_id: ids.host,
        metric: 'host.memory.utilisation_percent',
        ts: latest,
        value: 88,
        unit: 'percent',
        labels: {},
        source_run_id: randomUUID(),
      },
    ]);
    const host = await gql<Headline>(query, { id: ids.host });
    expect(host.errors).toBeUndefined();
    expect(host.data?.ci?.headlineMetric).toEqual({
      key: 'cpuPercent',
      label: 'Host load',
      unit: '%',
      metric: 'host.cpu.utilisation_percent',
      value: 41.5,
      observedAt: '2026-10-22T09:30:00.000Z',
    });

    const db = await gql<Headline>(query, { id: ids.db });
    expect(db.data?.ci?.headlineMetric).toEqual({
      key: 'iops',
      label: 'IOPS',
      unit: '',
      metric: 'db.instance.iops',
      value: null,
      observedAt: null,
    });

    const unknownId = randomUUID();
    await prisma.ci.create({
      data: {
        ...ciRow(unknownId, 'unknown', 'unknown', '10.20.4.99', {}, { address: '10.20.4.99' }),
        observedAt: new Date(Date.now() - 3 * TIME.msPerDay - TIME.msPerSecond),
      },
    });
    const unknown = await gql<Headline>(query, { id: unknownId });
    expect(unknown.data?.ci?.headlineMetric).toMatchObject({
      key: 'lastSeenDays',
      unit: 'd',
      metric: 'discovery.last_seen.days',
      value: 3,
    });
    expect(unknown.data?.ci?.headlineMetric.observedAt).not.toBeNull();

    // One ClickHouse round trip per page: the loader batches every CI of the list query.
    type Page = { cis: { edges: Array<{ node: { id: string; headlineMetric: { value: number | null } } }> } };
    const page = await gql<Page>(
      'query { cis(filter: { tags: ["integration-test"] }, first: 20) { edges { node { id headlineMetric { value } } } } }',
    );
    expect(page.errors).toBeUndefined();
    const byId = new Map(page.data?.cis.edges.map((e) => [e.node.id, e.node.headlineMetric.value]));
    expect(byId.get(ids.host)).toBe(41.5);
    expect(byId.get(ids.db)).toBeNull();
    const metricsText = (await app.inject({ method: 'GET', url: env.METRICS_PATH })).body;
    expect(metricsText).toMatch(
      /openmap_clickhouse_queries_total\{query="headline_metrics",status="ok"\} [1-9]/,
    );
  });

  it('reads a CI as of a point in time', async () => {
    const query =
      'query Ci($id: UUID!, $asOf: DateTime) { ci(id: $id, asOf: $asOf) { id name validFrom validTo } }';
    const before = await gql<{ ci: unknown }>(query, {
      id: ids.host,
      asOf: new Date(createdAt.getTime() - 60_000).toISOString(),
    });
    expect(before.data?.ci).toBeNull();
    const now = await gql<{ ci: { id: string; validTo: string | null } }>(query, {
      id: ids.host,
      asOf: new Date().toISOString(),
    });
    expect(now.data?.ci.id).toBe(ids.host);
    expect(now.data?.ci.validTo).toBeNull();
    const current = await gql<{ ci: { id: string } }>(query, { id: ids.host });
    expect(current.data?.ci.id).toBe(ids.host);
    const missing = await gql<{ ci: unknown }>(query, { id: randomUUID() });
    expect(missing.data?.ci).toBeNull();
  });

  it('labels a CI through the outbox and enforces the operator role', async () => {
    const mutation =
      'mutation Label($input: LabelCiInput!) { labelCi(input: $input) { id layer userLabel { title layer labelledBy } } }';
    const input = {
      ciId: ids.host,
      title: 'Ledger primary',
      description: 'Primary Postgres node for the ledger',
      layer: 'databases',
    };
    const denied = await gql<{ labelCi: unknown }>(mutation, { input }, viewerToken);
    expect(denied.errors?.[0]?.message).toMatch(/roles/i);
    const res = await gql<{
      labelCi: { id: string; layer: string; userLabel: { title: string; layer: string; labelledBy: string } };
    }>(mutation, { input });
    expect(res.errors).toBeUndefined();
    expect(res.data?.labelCi.layer).toBe('databases');
    expect(res.data?.labelCi.userLabel).toEqual({
      title: 'Ledger primary',
      layer: 'databases',
      labelledBy: 'tester',
    });
    const outbox = await prisma.outboxEvent.findMany({
      where: { tenantId, type: 'openmap.ci.labelled', subject: ids.host },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.pending).toContain('memgraph');
    expect(outbox[0]?.deliveredAt).toBeNull();
    const envelope = outbox[0]?.envelope as {
      specversion: string;
      tenantid: string;
      data: { label: { title: string } };
    };
    expect(envelope.specversion).toBe('1.0');
    expect(envelope.tenantid).toBe(tenantId);
    expect(envelope.data.label.title).toBe('Ledger primary');
  });

  it('records every mutation in the immutable audit log and serves it to auditors only', async () => {
    const before = await prisma.auditLog.count({ where: { tenantId } });
    const input = {
      ciId: ids.subnet,
      title: 'Audited subnet',
      description: 'audit trail check',
      layer: 'network_security',
    };
    const labelled = await gql<{ labelCi: { id: string } }>(
      'mutation LabelForAudit($input: LabelCiInput!) { labelCi(input: $input) { id } }',
      { input },
    );
    expect(labelled.errors).toBeUndefined();
    const rows = await prisma.auditLog.findMany({ where: { tenantId }, orderBy: { at: 'desc' } });
    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({
      actor: 'tester',
      action: 'labelCi',
      subjectType: 'Ci',
      subjectId: ids.subnet,
    });
    expect((rows[0]!.details as { arguments: { input: { title: string } } }).arguments.input.title).toBe(
      'Audited subnet',
    );
    await expect(prisma.auditLog.delete({ where: { id: rows[0]!.id } })).rejects.toThrow(/append-only/);

    const asOperator = await gql<{
      auditLog: { totalCount: number; edges: Array<{ node: { action: string } }> };
    }>(
      '{ auditLog(action: "labelCi", first: 5) { totalCount edges { node { action actor subjectId } } } }',
      {},
      operatorToken,
    );
    expect(asOperator.errors?.[0]?.message).toMatch(/roles/);
    const auditorToken = await mint([ROLES.auditor], keys.privateKey);
    const asAuditor = await gql<{
      auditLog: { totalCount: number; edges: Array<{ node: { action: string; subjectId: string } }> };
    }>(
      '{ auditLog(action: "labelCi", first: 5) { totalCount edges { node { action actor subjectId } } } }',
      {},
      auditorToken,
    );
    expect(asAuditor.errors).toBeUndefined();
    expect(asAuditor.data?.auditLog.totalCount).toBeGreaterThanOrEqual(1);
    expect(asAuditor.data?.auditLog.edges[0]?.node.subjectId).toBe(ids.subnet);
  });

  it('serves tenant settings to every signed-in role and lets only administrators change them', async () => {
    // T-097 REQ-UI-019 REQ-CORE-012
    const fields =
      '{ locale timeZone discoveryIntervalMinutes historyRetentionDays staleAfterDays auditRetentionDays assistantEnabled outboundIntegrationsEnabled }';
    const read = await gql<{ tenantSettings: TenantSettings }>('{ tenantSettings ' + fields + ' }');
    expect(read.errors).toBeUndefined();
    expect(read.data?.tenantSettings).toEqual(TENANT_SETTINGS_DEFAULTS);

    const denied = await gql(
      'mutation { updateTenantSettings(input: { staleAfterDays: 14 }) { staleAfterDays } }',
    );
    expect(denied.errors?.[0]?.message).toMatch(/roles/);

    const adminToken = await mint([ROLES.admin], keys.privateKey);
    const updated = await gql<{ updateTenantSettings: TenantSettings }>(
      'mutation { updateTenantSettings(input: { staleAfterDays: 14, locale: "ar", timeZone: null }) ' +
        fields +
        ' }',
      {},
      adminToken,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.updateTenantSettings).toEqual({
      ...TENANT_SETTINGS_DEFAULTS,
      staleAfterDays: 14,
      locale: 'ar',
    });
    const again = await gql<{ tenantSettings: TenantSettings }>('{ tenantSettings ' + fields + ' }');
    expect(again.data?.tenantSettings.staleAfterDays).toBe(14);

    const invalid = await gql(
      'mutation { updateTenantSettings(input: { discoveryIntervalMinutes: 0 }) { locale } }',
      {},
      adminToken,
    );
    expect(invalid.errors?.[0]?.message).toMatch(/updateTenantSettings input/);
    const audited = await prisma.auditLog.findFirst({ where: { tenantId, action: 'updateTenantSettings' } });
    expect(audited).not.toBeNull();
  });

  it('creates and retires relationships through the outbox', async () => {
    const created = await gql<{
      createRelationship: { id: string; type: string; from: { id: string }; to: { id: string } };
    }>(
      'mutation Rel($type: String!, $from: UUID!, $to: UUID!) { createRelationship(type: $type, fromCiId: $from, toCiId: $to, attributes: { note: "test" }) { id type from { id } to { id } } }',
      { type: 'located_in', from: ids.host, to: ids.pdu },
    );
    expect(created.errors).toBeUndefined();
    expect(created.data?.createRelationship.from.id).toBe(ids.host);
    const retired = await gql<{ retireRelationship: { id: string; validTo: string | null } }>(
      'mutation Retire($id: UUID!) { retireRelationship(id: $id) { id validTo } }',
      { id: created.data?.createRelationship.id },
    );
    expect(retired.data?.retireRelationship.validTo).not.toBeNull();
    const types = (
      await prisma.outboxEvent.findMany({ where: { tenantId, subject: created.data?.createRelationship.id } })
    )
      .map((e) => e.type)
      .sort();
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
    const toggled = await gql<{ setLayerVisibility: Layers['layers'] }>(
      'mutation { setLayerVisibility(layer: hardware, visible: false) { layer visible } }',
    );
    expect(toggled.data?.setLayerVisibility.find((l) => l.layer === 'hardware')?.visible).toBe(false);
    expect(toggled.data?.setLayerVisibility.filter((l) => l.visible)).toHaveLength(11);
    const pref = await prisma.userPreference.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
    expect(pref?.visibleLayers).not.toContain('hardware');
    // REQ-CMDB-003: a hidden layer leaves every list until it is shown again; an explicit filter still reaches it.
    const hiddenList = await gql<{ cis: { totalCount: number; edges: Array<{ node: { layer: string } }> } }>(
      '{ cis(first: 50) { totalCount edges { node { layer } } } }',
    );
    expect(hiddenList.data?.cis.edges.some((e) => e.node.layer === 'hardware')).toBe(false);
    // The host was relabelled into the databases layer earlier in this suite, so hide that layer too and reach it explicitly.
    await gql('mutation { setLayerVisibility(layer: databases, visible: false) { layer } }');
    const bothHidden = await gql<{ cis: { edges: Array<{ node: { layer: string } }> } }>(
      '{ cis(first: 50) { edges { node { layer } } } }',
    );
    expect(bothHidden.data?.cis.edges.some((e) => e.node.layer === 'databases')).toBe(false);
    const explicit = await gql<{ cis: { totalCount: number } }>(
      '{ cis(filter: { layers: [databases] }, first: 50) { totalCount } }',
    );
    const databasesRows = await prisma.ci.count({ where: { tenantId, layer: 'databases', validTo: null } });
    expect(databasesRows).toBeGreaterThan(0);
    expect(explicit.data?.cis.totalCount).toBe(databasesRows);
    await gql('mutation { setLayerVisibility(layer: databases, visible: true) { layer } }');
    await gql('mutation { setLayerVisibility(layer: hardware, visible: true) { layer } }');
    const shownAgain = await gql<{ cis: { edges: Array<{ node: { layer: string } }> } }>(
      '{ cis(first: 50) { edges { node { layer } } } }',
    );
    expect(shownAgain.data?.cis.edges.some((e) => e.node.layer === 'databases')).toBe(true);
  });

  it('computes impact from a failed PDU up to the business service', async () => {
    type Impact = {
      impact: {
        root: { id: string };
        durationMs: number;
        nodes: Array<{ ci: { name: string }; depth: number; predicted: string; path: string[] }>;
        services: Array<{
          service: { name: string };
          tier: number;
          predicted: string;
          usersAffected: number | null;
          revenueAtRiskPerHour: { amount: number; currency: string } | null;
          slaBudgetRemainingMinutes: number | null;
        }>;
      };
    };
    const res = await gql<Impact>(
      'query Impact($id: UUID!) { impact(ciId: $id) { root { id } durationMs nodes { ci { name } depth predicted path } services { service { name } tier predicted usersAffected revenueAtRiskPerHour { amount currency } slaBudgetRemainingMinutes } } }',
      { id: ids.pdu },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.impact.root.id).toBe(ids.pdu);
    const names = res.data?.impact.nodes.map((n) => n.ci.name) ?? [];
    expect(names).toEqual(
      expect.arrayContaining(['db-ryd-pg-core-01', 'Ledger DB', 'app-ledger', 'Online banking']),
    );
    expect(res.data?.impact.nodes.find((n) => n.ci.name === 'db-ryd-pg-core-01')).toMatchObject({
      depth: 1,
      predicted: 'down',
    });
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
    const res = await gql<{ path: Array<{ type: string; from: { name: string }; to: { name: string } }> }>(
      'query P($a: UUID!, $b: UUID!) { path(fromCiId: $a, toCiId: $b) { type from { name } to { name } } }',
      { a: ids.app, b: ids.pdu },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.path.map((r) => r.type)).toEqual(['depends_on', 'runs_on', 'powered_by']);
  });

  it('creates a plan whose BOM becomes planned assets in one transaction', async () => {
    type Plan = {
      createPlan: {
        id: string;
        number: string;
        status: string;
        estimatedCost: { amount: number; currency: string } | null;
        bom: Array<{ description: string; quantity: number; received: number }>;
        assets: Array<{
          id: string;
          assetTag: string;
          stage: string;
          manufacturer: string;
          model: string;
          purchaseCost: { amount: number; currency: string } | null;
        }>;
      };
    };
    const res = await gql<Plan>(
      'mutation Plan($input: PlanInput!) { createPlan(input: $input) { id number status estimatedCost { amount currency } bom { description quantity received } assets { id assetTag stage manufacturer model purchaseCost { amount currency } } } }',
      {
        input: {
          name: 'Ledger refresh',
          description: 'Replace the ledger database hosts',
          kind: 'refresh',
          targetSiteId: ids.pdu,
          bom: [
            {
              description: 'Database host',
              manufacturer: 'Dell',
              model: 'R760',
              sku: 'R760-2S',
              layer: 'hardware',
              quantity: 2,
              unitCostAmount: 45_000,
              unitCostCurrency: 'SAR',
            },
            {
              description: 'Top-of-rack switch',
              manufacturer: 'Arista',
              model: '7050X3',
              layer: 'network_security',
              quantity: 1,
              unitCostAmount: 30_000,
              unitCostCurrency: 'SAR',
            },
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
    expect(plan?.assets.map((a) => a.assetTag).sort()).toEqual([
      plan?.number + '-1-1',
      plan?.number + '-1-2',
      plan?.number + '-2-1',
    ]);
    expect(plan?.assets.find((a) => a.assetTag.endsWith('-2-1'))).toMatchObject({
      manufacturer: 'Arista',
      model: '7050X3',
      purchaseCost: { amount: 30_000, currency: 'SAR' },
    });
    const audits = await prisma.assetAudit.count({ where: { tenantId, asset: { planId: plan?.id } } });
    expect(audits).toBe(3);
    const events = await prisma.outboxEvent.findMany({
      where: { tenantId, type: 'openmap.asset.stage.changed' },
    });
    expect(events).toHaveLength(3);

    const staged = await gql<{ setAssetStage: { stage: string } }>(
      'mutation S($id: UUID!) { setAssetStage(assetId: $id, stage: in_stock, note: "received") { stage } }',
      { id: plan?.assets[0]?.id },
    );
    expect(staged.data?.setAssetStage.stage).toBe('in_stock');
    const approved = await gql<{ setPlanStatus: { status: string } }>(
      'mutation A($id: UUID!) { setPlanStatus(planId: $id, status: approved) { status } }',
      { id: plan?.id },
    );
    expect(approved.data?.setPlanStatus.status).toBe('approved');
    const listed = await gql<{ assets: Array<{ assetTag: string }>; plans: Array<{ number: string }> }>(
      '{ assets(stage: [in_stock]) { assetTag } plans(status: [approved]) { number } }',
    );
    expect(listed.data?.assets).toHaveLength(1);
    expect(listed.data?.plans.map((p) => p.number)).toEqual([plan?.number]);
  });

  it('keeps the asset register across layers: manual entry creates a CI, details are audited, gaps and the summary follow, labelling an unknown device registers it (REQ-CMDB-039, REQ-CMDB-040)', async () => {
    type Asset = {
      id: string;
      assetTag: string;
      layer: string;
      ciType: string | null;
      source: string;
      serialNumber: string | null;
      manufacturer: string | null;
      dataGaps: string[];
      warranty: { provider: string; endsAt: string; source: string } | null;
      ci: { id: string; type: string; layer: string } | null;
      audits: Array<{ field: string; actor: string }>;
    };
    const fields =
      'id assetTag layer ciType source serialNumber manufacturer dataGaps warranty { provider endsAt source } ci { id type layer } audits { field actor }';
    const created = await gql<{ createAsset: Asset }>(
      'mutation C($input: ManualAssetInput!) { createAsset(input: $input) { ' + fields + ' } }',
      {
        input: {
          layer: 'dc',
          type: 'pdu',
          name: 'PDU rack 7 left',
          details: { manufacturer: 'APC', model: 'AP7921', serialNumber: 'PDU-7L' },
        },
      },
    );
    expect(created.errors).toBeUndefined();
    const asset = created.data?.createAsset;
    expect(asset).toMatchObject({
      layer: 'dc',
      ciType: 'pdu',
      source: 'manual',
      serialNumber: 'PDU-7L',
      dataGaps: ['warranty', 'support', 'end_of_life'],
    });
    expect(asset?.ci).toMatchObject({ type: 'pdu', layer: 'dc' });
    expect(asset?.audits.map((a) => a.field).sort()).toEqual([
      'manufacturer',
      'model',
      'serialNumber',
      'stage',
    ]);
    expect(
      await prisma.outboxEvent.count({
        where: { tenantId, type: 'openmap.ci.created', subject: asset?.ci?.id },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { tenantId, type: 'openmap.asset.created', subject: asset?.id },
      }),
    ).toBe(1);

    const updated = await gql<{ updateAsset: Asset }>(
      'mutation U($id: UUID!, $input: AssetDetailsInput!) { updateAsset(assetId: $id, input: $input) { ' +
        fields +
        ' } }',
      {
        id: asset?.id,
        input: { warranty: { provider: 'APC', endsAt: '2029-03-31' }, note: 'from the invoice' },
      },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.updateAsset.warranty).toMatchObject({
      provider: 'APC',
      endsAt: '2029-03-31T00:00:00.000Z',
      source: 'manual',
    });
    expect(updated.data?.updateAsset.dataGaps).toEqual(['support', 'end_of_life']);
    expect(updated.data?.updateAsset.audits.some((a) => a.field === 'warranty' && a.actor === 'tester')).toBe(
      true,
    );
    expect(
      await prisma.outboxEvent.count({
        where: { tenantId, type: 'openmap.asset.updated', subject: asset?.id },
      }),
    ).toBe(1);

    const gaps = await gql<{
      assets: Asset[];
      assetSummary: Array<{ layer: string; count: number; needsData: number }>;
    }>(
      '{ assets(filter: { layers: [dc], dataGaps: [warranty] }) { id } assetSummary { layer count needsData } }',
    );
    expect(gaps.errors).toBeUndefined();
    expect(gaps.data?.assets.map((a) => a.id)).not.toContain(asset?.id);
    expect(gaps.data?.assetSummary.find((row) => row.layer === 'dc')).toMatchObject({
      count: 1,
      needsData: 1,
    });
    const text = await gql<{ assets: Asset[] }>('{ assets(filter: { text: "rack 7 left" }) { id } }');
    expect(text.data?.assets.map((a) => a.id)).toContain(asset?.id);

    const unknownId = randomUUID();
    await prisma.ci.create({
      data: ciRow(unknownId, 'unknown', 'unknown', 'ups_card-4416', {
        deviceKind: 'ups_card',
        snmpReachable: true,
        manufacturer: 'Schneider Electric',
        model: 'AP9641',
        serialNumber: 'UPS-4416',
      }),
    });
    const labelled = await gql<{ labelCi: { id: string; type: string; asset: Asset | null } }>(
      'mutation L($input: LabelCiInput!) { labelCi(input: $input) { id type asset { ' + fields + ' } } }',
      {
        input: {
          ciId: unknownId,
          title: 'UPS card rack 12',
          description: 'APC network management card',
          layer: 'dc',
          type: 'ups',
        },
      },
    );
    expect(labelled.errors).toBeUndefined();
    expect(labelled.data?.labelCi.type).toBe('ups');
    expect(labelled.data?.labelCi.asset).toMatchObject({
      ciType: 'ups',
      layer: 'dc',
      source: 'discovery',
      serialNumber: 'UPS-4416',
      manufacturer: 'Schneider Electric',
    });
    // REQ-CMDB-041 — pages by number carry the totals under the same filter; a page past the end is empty, not an error.
    type Page = {
      items: Array<{ id: string }>;
      totalCount: number;
      page: number;
      pageSize: number;
      pageCount: number;
    };
    const paged = await gql<{ first: Page; second: Page; beyond: Page }>(
      '{ first: assetPage(filter: { layers: [dc] }, page: 1, pageSize: 1) { items { id } totalCount page pageSize pageCount } second: assetPage(filter: { layers: [dc] }, page: 2, pageSize: 1) { items { id } totalCount page pageSize pageCount } beyond: assetPage(filter: { layers: [dc] }, page: 9, pageSize: 1) { items { id } totalCount pageCount } }',
    );
    expect(paged.errors).toBeUndefined();
    expect(paged.data?.first).toMatchObject({ totalCount: 2, page: 1, pageSize: 1, pageCount: 2 });
    expect(paged.data?.first.items).toHaveLength(1);
    expect(paged.data?.second.items).toHaveLength(1);
    expect(paged.data?.second.items[0]?.id).not.toBe(paged.data?.first.items[0]?.id);
    expect(paged.data?.beyond).toMatchObject({ totalCount: 2, pageCount: 2, items: [] });
    const tooBig = await gql<{ assetPage: Page }>('{ assetPage(pageSize: 100000) { totalCount } }');
    expect(tooBig.errors?.[0]?.message).toMatch(/assetPage arguments/);

    // REQ-CMDB-042 (ADR-027) — a SaaS asset carries a subscription instead of a warranty: term, credits, the gap and the summary follow.
    type SubAsset = Asset & {
      subscription: {
        provider: string;
        plan: string | null;
        endsAt: string | null;
        credits: { remaining: number; unit: string; currency: string | null; asOf: string } | null;
        source: string;
      } | null;
      subscriptionEndsAt: string | null;
      creditsRemaining: number | null;
    };
    const subFields =
      fields +
      ' subscription { provider plan endsAt credits { remaining unit currency asOf } source } subscriptionEndsAt creditsRemaining';
    const saas = await gql<{ createAsset: SubAsset }>(
      'mutation S($input: ManualAssetInput!) { createAsset(input: $input) { ' + subFields + ' } }',
      {
        input: {
          layer: 'saas',
          type: 'saas_application',
          name: 'Payroll cloud',
          details: {
            manufacturer: 'Workday',
            model: 'HCM',
            subscription: {
              provider: 'Workday',
              plan: 'Enterprise',
              startsAt: '2026-01-01',
              endsAt: '2026-12-31',
              creditsRemaining: 1250,
              creditsUnit: 'seats',
            },
          },
        },
      },
    );
    expect(saas.errors).toBeUndefined();
    expect(saas.data?.createAsset.subscription).toMatchObject({
      provider: 'Workday',
      plan: 'Enterprise',
      endsAt: '2026-12-31T00:00:00.000Z',
      source: 'manual',
      credits: { remaining: 1250, unit: 'seats', currency: null },
    });
    expect(saas.data?.createAsset.subscriptionEndsAt).toBe('2026-12-31T00:00:00.000Z');
    expect(saas.data?.createAsset.creditsRemaining).toBe(1250);
    // A subscription type never asks for a warranty, and its subscription is filled, so only support and end of life remain.
    expect(saas.data?.createAsset.dataGaps).toEqual(['support', 'end_of_life']);
    const saasId = saas.data?.createAsset.id;
    const subGap = await gql<{
      assets: Asset[];
      assetSummary: Array<{ layer: string; count: number; needsData: number; subscriptionExpired: number }>;
    }>(
      '{ assets(filter: { layers: [saas], dataGaps: [subscription] }) { id } assetSummary { layer count needsData subscriptionExpired } }',
    );
    expect(subGap.errors).toBeUndefined();
    expect(subGap.data?.assets.map((a) => a.id)).not.toContain(saasId);
    expect(subGap.data?.assetSummary.find((row) => row.layer === 'saas')).toMatchObject({
      count: 1,
      subscriptionExpired: 0,
    });
    const clearedSubscription = await gql<{ updateAsset: SubAsset }>(
      'mutation U($id: UUID!, $input: AssetDetailsInput!) { updateAsset(assetId: $id, input: $input) { ' +
        subFields +
        ' } }',
      { id: saasId, input: { subscription: null } },
    );
    expect(clearedSubscription.errors).toBeUndefined();
    expect(clearedSubscription.data?.updateAsset.subscription).toBeNull();
    expect(clearedSubscription.data?.updateAsset.dataGaps).toEqual([
      'subscription',
      'support',
      'end_of_life',
    ]);
    expect(clearedSubscription.data?.updateAsset.audits.some((a) => a.field === 'subscription')).toBe(true);
    const invalid = await gql<{ updateAsset: SubAsset }>(
      'mutation U($id: UUID!, $input: AssetDetailsInput!) { updateAsset(assetId: $id, input: $input) { id } }',
      { id: saasId, input: { subscription: { provider: 'Workday' } } },
    );
    expect(invalid.errors?.[0]?.message).toMatch(/updateAsset arguments|end date or a credit balance/);
    // The licence CI of the fixture carries expiresAt and vendor: labelling an unknown CI into a licence maps them to a subscription.
    const licenceId = randomUUID();
    await prisma.ci.create({
      data: ciRow(licenceId, 'unknown', 'unknown', 'app-7781', {
        vendor: 'Atlassian',
        expiresAt: '2027-06-30',
        licenceType: 'subscription',
        creditsRemaining: 40,
        creditsUnit: 'seats',
      }),
    });
    const asLicence = await gql<{ labelCi: { asset: SubAsset | null } }>(
      'mutation L($input: LabelCiInput!) { labelCi(input: $input) { asset { ' + subFields + ' } } }',
      {
        input: {
          ciId: licenceId,
          title: 'Jira licence',
          description: 'from the invoice',
          layer: 'applications',
          type: 'licence',
        },
      },
    );
    expect(asLicence.errors).toBeUndefined();
    expect(asLicence.data?.labelCi.asset?.subscription).toMatchObject({
      provider: 'Atlassian',
      plan: 'subscription',
      endsAt: '2027-06-30T00:00:00.000Z',
      source: 'vendor_api',
      credits: { remaining: 40, unit: 'seats' },
    });
  });

  it('assigns an SLA, reports availability by period from the ClickHouse history, and runs an incident through assignment, RCA, resolution and closure with every step on the timeline (REQ-BSM-006, REQ-BSM-008)', async () => {
    // T-135 ADR-024
    const clickhouse = app.get(ClickHouseService);
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const previousMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    const minute = TIME.secondsPerMinute * TIME.msPerSecond;
    const chTs = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
    const row = (ms: number, health: string, score: number) => ({
      tenant_id: tenantId,
      service_ci_id: ids.service,
      health,
      score,
      cause_ci_id: null,
      sla_budget_remaining_minutes: null,
      ts: chTs(ms),
    });
    // Last month: 30 minutes degraded. This month: a 60-minute outage one hour after the month began.
    await clickhouse.insert('service_health_history', [
      row(previousMonthStart + 2 * minute, 'degraded', 0.5),
      row(previousMonthStart + 32 * minute, 'healthy', 1),
      row(monthStart + 60 * minute, 'down', 0),
      row(monthStart + 120 * minute, 'healthy', 1),
    ]);

    type Sla = {
      id: string;
      name: string;
      availabilityTargetPercent: number;
      window: string;
      responseTargets: Array<{ severity: string; respondMinutes: number; resolveMinutes: number }>;
      services: Array<{ id: string }>;
    };
    const created = await gql<{ upsertSla: Sla }>(
      'mutation S($input: SlaInput!) { upsertSla(input: $input) { id name availabilityTargetPercent window responseTargets { severity respondMinutes resolveMinutes } services { id } } }',
      {
        input: {
          name: 'Gold',
          availabilityTargetPercent: 99.9,
          window: 'calendar_month',
          responseTargets: [{ severity: 'critical', respondMinutes: 10, resolveMinutes: 60 }],
        },
      },
    );
    expect(created.errors).toBeUndefined();
    const sla = created.data?.upsertSla;
    expect(sla).toMatchObject({ name: 'Gold', window: 'calendar_month', services: [] });
    expect(sla?.responseTargets.find((t) => t.severity === 'critical')).toMatchObject({
      respondMinutes: 10,
      resolveMinutes: 60,
    });
    expect(sla?.responseTargets.find((t) => t.severity === 'high')?.respondMinutes).toBeGreaterThan(0);

    const denied = await gql<{ assignSla: unknown }>(
      'mutation A($serviceId: UUID!, $slaId: UUID) { assignSla(serviceId: $serviceId, slaId: $slaId) { slaTarget } }',
      { serviceId: ids.service, slaId: sla?.id },
      viewerToken,
    );
    expect(denied.errors?.[0]?.message).toMatch(/roles/);

    type Period = {
      year: number;
      month: number | null;
      quarter: number | null;
      current: boolean;
      availabilityPercent: number | null;
      downtimeMinutes: number;
      degradedMinutes: number;
      targetPercent: number | null;
      met: boolean | null;
      budgetMinutes: number | null;
      incidents: Array<{ id: string }>;
    };
    type Health = {
      slaTarget: number;
      errorBudgetRemainingMinutes: number;
      sla: { id: string } | null;
      currentWindow: Period;
      availability: Period[];
    };
    const periodFields =
      'year month quarter current availabilityPercent downtimeMinutes degradedMinutes targetPercent met budgetMinutes incidents { id }';
    const assigned = await gql<{ assignSla: Health }>(
      'mutation A($serviceId: UUID!, $slaId: UUID) { assignSla(serviceId: $serviceId, slaId: $slaId) { slaTarget errorBudgetRemainingMinutes sla { id } currentWindow { ' +
        periodFields +
        ' } availability(granularity: month, periods: 2) { ' +
        periodFields +
        ' } } }',
      { serviceId: ids.service, slaId: sla?.id },
    );
    expect(assigned.errors).toBeUndefined();
    const health = assigned.data?.assignSla;
    expect(health?.sla?.id).toBe(sla?.id);
    expect(health?.slaTarget).toBe(99.9);
    expect(health?.currentWindow).toMatchObject({
      current: true,
      downtimeMinutes: 60,
      targetPercent: 99.9,
      met: false,
    });
    expect(health?.currentWindow.budgetMinutes).toBeGreaterThan(0);
    expect(health?.errorBudgetRemainingMinutes).toBeCloseTo(
      (health?.currentWindow.budgetMinutes ?? 0) - 60,
      6,
    );
    expect(health?.availability).toHaveLength(2);
    const [previous, current] = health?.availability ?? [];
    expect(previous).toMatchObject({
      current: false,
      downtimeMinutes: 0,
      degradedMinutes: 30,
      availabilityPercent: 100,
      met: true,
      quarter: null,
    });
    expect(current).toMatchObject({
      current: true,
      downtimeMinutes: 60,
      met: false,
      month: now.getUTCMonth() + 1,
    });
    expect(current?.availabilityPercent ?? 100).toBeLessThan(100);

    const report = await gql<{
      availabilityReport: Array<{ service: { id: string }; sla: { name: string } | null; periods: Period[] }>;
      availabilityReportCsv: string;
    }>(
      '{ availabilityReport(granularity: quarter, periods: 1) { service { id } sla { name } periods { quarter current downtimeMinutes } } availabilityReportCsv(granularity: year, periods: 1) }',
    );
    expect(report.errors).toBeUndefined();
    const ours = report.data?.availabilityReport.find((r) => r.service.id === ids.service);
    expect(ours?.sla?.name).toBe('Gold');
    expect(ours?.periods).toHaveLength(1);
    expect(ours?.periods[0]?.downtimeMinutes).toBeGreaterThanOrEqual(60);
    const csv = report.data?.availabilityReportCsv ?? '';
    expect(csv.split('\n')[0]).toBe(
      'service,code,sla,granularity,year,month,quarter,period_start,period_end,availability_percent,target_percent,met,downtime_minutes,degraded_minutes,unknown_minutes,elapsed_minutes',
    );
    expect(csv).toContain('"Online banking"');
    expect(csv).toContain('"Gold"');

    // An incident the engine would have opened during this month's outage, run through the response flow.
    const incidentRow = await prisma.incident.create({
      data: {
        tenantId,
        title: 'Online banking down',
        description: 'Ledger DB lost power',
        severity: 'critical',
        state: 'open',
        source: 'bsm',
        affectedServiceCiIds: [ids.service],
        rootCauseCiId: ids.pdu,
        correlatedEventIds: [],
        openedAt: new Date(monthStart + 60 * minute),
        slaId: sla?.id,
        respondBy: new Date(monthStart + 70 * minute),
        resolveBy: new Date(monthStart + 120 * minute),
      },
    });
    type Incident = {
      id: string;
      state: string;
      severity: string;
      assignee: string | null;
      acknowledgedAt: string | null;
      resolvedAt: string | null;
      closedAt: string | null;
      resolutionNote: string | null;
      sla: { name: string } | null;
      rca: {
        summary: string;
        rootCauseCi: { id: string } | null;
        correctiveActions: Array<{ description: string; owner: string | null; done: boolean }>;
        updatedBy: string;
      } | null;
      timeline: Array<{ kind: string; actor: string }>;
    };
    const incidentFields =
      'id state severity assignee acknowledgedAt resolvedAt closedAt resolutionNote sla { name } rca { summary rootCauseCi { id } correctiveActions { description owner done } updatedBy } timeline { kind actor }';
    const assignedIncident = await gql<{ assignIncident: Incident }>(
      'mutation I($id: UUID!) { assignIncident(incidentId: $id, assignee: "ops.lead") { ' +
        incidentFields +
        ' } }',
      { id: incidentRow.id },
    );
    expect(assignedIncident.errors).toBeUndefined();
    expect(assignedIncident.data?.assignIncident).toMatchObject({
      state: 'acknowledged',
      assignee: 'ops.lead',
      severity: 'critical',
    });
    expect(assignedIncident.data?.assignIncident.acknowledgedAt).not.toBeNull();
    expect(assignedIncident.data?.assignIncident.sla?.name).toBe('Gold');

    const rca = await gql<{ updateIncidentRca: Incident }>(
      'mutation R($id: UUID!, $input: RcaInput!) { updateIncidentRca(incidentId: $id, input: $input) { ' +
        incidentFields +
        ' } }',
      {
        id: incidentRow.id,
        input: {
          summary: 'Single PDU feed; breaker tripped under load',
          rootCauseCiId: ids.pdu,
          contributingFactors: ['no redundant feed', 'breaker undersized'],
          correctiveActions: [{ description: 'Add B-side feed to rack 12', owner: 'dc.ops' }],
          owner: 'ops.lead',
        },
      },
    );
    expect(rca.errors).toBeUndefined();
    expect(rca.data?.updateIncidentRca.rca).toMatchObject({
      summary: 'Single PDU feed; breaker tripped under load',
      rootCauseCi: { id: ids.pdu },
      updatedBy: 'tester',
      correctiveActions: [{ description: 'Add B-side feed to rack 12', owner: 'dc.ops', done: false }],
    });

    const resolved = await gql<{ resolveIncident: Incident }>(
      'mutation V($id: UUID!) { resolveIncident(incidentId: $id, note: "Feed restored, breaker replaced") { ' +
        incidentFields +
        ' } }',
      { id: incidentRow.id },
    );
    expect(resolved.errors).toBeUndefined();
    expect(resolved.data?.resolveIncident).toMatchObject({
      state: 'resolved',
      resolutionNote: 'Feed restored, breaker replaced',
    });
    expect(resolved.data?.resolveIncident.resolvedAt).not.toBeNull();

    const closed = await gql<{ closeIncident: Incident }>(
      'mutation X($id: UUID!) { closeIncident(incidentId: $id) { ' + incidentFields + ' } }',
      { id: incidentRow.id },
    );
    expect(closed.errors).toBeUndefined();
    expect(closed.data?.closeIncident.state).toBe('closed');
    expect(closed.data?.closeIncident.closedAt).not.toBeNull();
    const kinds = closed.data?.closeIncident.timeline.map((t) => t.kind) ?? [];
    for (const kind of [
      'assignIncident',
      'updateIncidentRca',
      'resolveIncident',
      'openmap.incident.updated:assigned',
      'openmap.incident.updated:rca_updated',
      'openmap.incident.resolved:resolved',
    ])
      expect(kinds).toContain(kind);
    expect(
      closed.data?.closeIncident.timeline
        .filter((t) => t.kind === 'assignIncident')
        .every((t) => t.actor === 'tester'),
    ).toBe(true);
    expect(
      await prisma.auditLog.count({
        where: { tenantId, subjectType: 'Incident', subjectId: incidentRow.id },
      }),
    ).toBeGreaterThanOrEqual(4);

    const lists = await gql<{
      open: Array<{ id: string }>;
      all: Array<{ id: string }>;
      one: { id: string; state: string } | null;
      period: { availability: Period[] } | null;
    }>(
      'query L($service: UUID!, $id: UUID!) { open: incidents(open: true, serviceId: $service) { id } all: incidents(open: false, serviceId: $service) { id } one: incident(id: $id) { id state } period: service(id: $service) { availability(granularity: month, periods: 1) { incidents { id } } } }',
      { service: ids.service, id: incidentRow.id },
    );
    expect(lists.errors).toBeUndefined();
    expect(lists.data?.open.map((i) => i.id)).not.toContain(incidentRow.id);
    expect(lists.data?.all.map((i) => i.id)).toContain(incidentRow.id);
    expect(lists.data?.one).toMatchObject({ id: incidentRow.id, state: 'closed' });
    expect(lists.data?.period?.availability[0]?.incidents.map((i) => i.id)).toContain(incidentRow.id);

    const cleared = await gql<{ assignSla: Health }>(
      'mutation A($serviceId: UUID!) { assignSla(serviceId: $serviceId, slaId: null) { sla { id } slaTarget } }',
      { serviceId: ids.service },
    );
    expect(cleared.errors).toBeUndefined();
    expect(cleared.data?.assignSla.sla).toBeNull();
    expect(cleared.data?.assignSla.slaTarget).toBe(99.95);
    const removed = await gql<{ deleteSla: boolean }>('mutation D($id: UUID!) { deleteSla(id: $id) }', {
      id: sla?.id,
    });
    expect(removed.data?.deleteSla).toBe(true);
    expect((await gql<{ slas: Sla[] }>('{ slas { id } }')).data?.slas.map((x) => x.id)).not.toContain(
      sla?.id,
    );
  });

  it('builds the subnet tree, utilisation and the next free address from stored CIs', async () => {
    type Subnets = {
      subnets: Array<{
        cidr: string;
        vrf: string | null;
        utilisationPercent: number;
        children: unknown[];
        addresses: { totalCount: number; edges: Array<{ node: { name: string } }> };
      }>;
      nextFreeIp: string | null;
    };
    const res = await gql<Subnets>(
      'query N($id: UUID!) { subnets { cidr vrf utilisationPercent children { cidr } addresses(first: 10) { totalCount edges { node { name } } } } nextFreeIp(subnetId: $id) }',
      { id: ids.subnet },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.subnets).toHaveLength(1);
    const subnet = res.data?.subnets[0];
    expect(subnet).toMatchObject({ cidr: '10.42.0.0/29', vrf: 'prod', children: [] });
    expect(subnet?.utilisationPercent).toBeCloseTo((2 / 6) * 100, 5);
    expect(subnet?.addresses.totalCount).toBe(2);
    expect(res.data?.nextFreeIp).toBe('10.42.0.3');
  });

  it('inventories software with licence compliance and walks a CVE to the services it puts at risk', async () => {
    // T-108 REQ-UI-015 REQ-UI-016 REQ-CMDB-031 REQ-SEC-008
    const software = await gql<{
      software: Array<{
        name: string;
        version: string;
        instances: number;
        hosts: number;
        running: number;
        vulnerabilities: number;
        licence: {
          entitlement: number;
          consumed: number;
          overDeployed: boolean;
          expiresAt: string | null;
        } | null;
      }>;
    }>(
      '{ software(first: 10) { name version instances hosts running vulnerabilities licence { entitlement consumed overDeployed expiresAt } } }',
    );
    expect(software.errors).toBeUndefined();
    expect(software.data?.software).toEqual([
      {
        name: 'PostgreSQL',
        version: '16.4',
        instances: 1,
        hosts: 1,
        running: 1,
        vulnerabilities: 1,
        licence: { entitlement: 32, consumed: 40, overDeployed: true, expiresAt: '2027-01-01T00:00:00.000Z' },
      },
    ]);

    const summaries = await gql<{
      vulnerabilitySummaries: Array<{
        cveId: string;
        cvss: number;
        exploited: boolean;
        affectedSoftware: number;
        affectedHosts: number;
      }>;
    }>('{ vulnerabilitySummaries(minCvss: 9) { cveId cvss exploited affectedSoftware affectedHosts } }');
    expect(summaries.data?.vulnerabilitySummaries).toEqual([
      { cveId: 'CVE-2026-0001', cvss: 9.8, exploited: true, affectedSoftware: 1, affectedHosts: 1 },
    ]);

    const detail = await gql<{
      vulnerability: {
        hosts: Array<{ id: string }>;
        services: Array<{ service: { id: string }; predicted: string }>;
        blastRadiusTruncated: boolean;
      } | null;
    }>(
      '{ vulnerability(cveId: "CVE-2026-0001") { hosts { id } services { service { id } predicted } blastRadiusTruncated } }',
    );
    expect(detail.data?.vulnerability?.hosts.map((h) => h.id)).toEqual([ids.host]);
    expect(detail.data?.vulnerability?.services.map((s) => s.service.id)).toEqual([ids.service]);
    expect(detail.data?.vulnerability?.blastRadiusTruncated).toBe(false);
    expect(
      (
        await gql<{ vulnerability: unknown }>(
          '{ vulnerability(cveId: "CVE-0000-0000") { blastRadiusTruncated } }',
        )
      ).data?.vulnerability,
    ).toBeNull();
  });

  it('renames a short code, refuses a taken or malformed one, and exposes the stored code', async () => {
    // T-111 REQ-CMDB-037
    const mutation =
      'mutation SetCode($ciId: UUID!, $code: String!) { setCiCode(ciId: $ciId, code: $code) { id code } }';
    const renamed = await gql<{ setCiCode: { id: string; code: string } }>(mutation, {
      ciId: ids.host,
      code: 'srv-ledger-primary',
    });
    expect(renamed.errors).toBeUndefined();
    expect(renamed.data?.setCiCode.code).toBe('SRV-LEDGER-PRIMARY');
    const read = await gql<{ ci: { code: string } }>('query Code($id: UUID!) { ci(id: $id) { code } }', {
      id: ids.host,
    });
    expect(read.data?.ci.code).toBe('SRV-LEDGER-PRIMARY');
    const taken = await gql<{ setCiCode: unknown }>(mutation, { ciId: ids.db, code: 'SRV-LEDGER-PRIMARY' });
    expect(taken.errors?.[0]?.message).toContain('already');
    const malformed = await gql<{ setCiCode: unknown }>(mutation, { ciId: ids.db, code: 'no prefix here' });
    expect(malformed.errors?.[0]?.message).toMatch(/code/i);
    const denied = await gql<{ setCiCode: unknown }>(
      mutation,
      { ciId: ids.db, code: 'DB-LEDGER' },
      viewerToken,
    );
    expect(denied.errors?.[0]?.message).toMatch(/roles/i);
    const stillDb = await gql<{ ci: { code: string } }>('query Code($id: UUID!) { ci(id: $id) { code } }', {
      id: ids.db,
    });
    expect(stillDb.data?.ci.code).toMatch(/^[A-Z]+-/);
  });

  it('values an asset under its depreciation schedule and raises low stock once when a spare reaches its reorder point (REQ-CMDB-017, REQ-CMDB-019)', async () => {
    // T-174 ADR-033
    type Valued = {
      id: string;
      bookValue: { amount: number; currency: string } | null;
      depreciation: { method: string; usefulLifeMonths: number; residualValue: { amount: number; currency: string } };
      stock: { onHand: number; reorderPoint: number; belowReorderPoint: boolean } | null;
      audits: Array<{ field: string }>;
    };
    const fields = 'id bookValue { amount currency } depreciation { method usefulLifeMonths residualValue { amount currency } } stock { onHand reorderPoint belowReorderPoint } audits { field }';
    // Bought on the first of the month a year ago: exactly twelve whole months have passed.
    const now = new Date();
    const purchasedAt = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)).toISOString().slice(0, 'YYYY-MM-DD'.length);
    const created = await gql<{ createAsset: Valued }>('mutation C($input: ManualAssetInput!) { createAsset(input: $input) { ' + fields + ' } }', {
      input: {
        layer: 'dc',
        type: 'pdu',
        name: 'Spare PSU shelf ' + String(Date.now()),
        details: {
          purchasedAt,
          purchaseCostAmount: 4800,
          purchaseCostCurrency: 'SAR',
          depreciation: { method: 'straight_line', usefulLifeMonths: 48, residualValueAmount: 0 },
          stock: { onHand: 5, reorderPoint: 2 },
        },
      },
    });
    expect(created.errors).toBeUndefined();
    const asset = created.data?.createAsset;
    expect(asset).toMatchObject({
      bookValue: { amount: 3600, currency: 'SAR' },
      depreciation: { method: 'straight_line', usefulLifeMonths: 48, residualValue: { amount: 0, currency: 'SAR' } },
      stock: { onHand: 5, reorderPoint: 2, belowReorderPoint: false },
    });
    expect(asset?.audits.map((a) => a.field)).toEqual(expect.arrayContaining(['depreciation', 'stock']));
    const update = 'mutation U($id: UUID!, $input: AssetDetailsInput!) { updateAsset(assetId: $id, input: $input) { ' + fields + ' } }';
    const lows = (): Promise<number> => prisma.outboxEvent.count({ where: { tenantId, type: 'openmap.asset.stock.low', subject: asset?.id } });
    expect(await lows()).toBe(0);

    // Declining balance at twice the straight-line rate, floored at the residual value.
    const declining = await gql<{ updateAsset: Valued }>(update, {
      id: asset?.id,
      input: { depreciation: { method: 'declining_balance', usefulLifeMonths: 24, residualValueAmount: 100 } },
    });
    expect(declining.errors).toBeUndefined();
    expect(declining.data?.updateAsset.bookValue?.amount).toBe(
      bookValue(4800, purchasedAt, { method: 'declining_balance', usefulLifeMonths: 24, residualValue: 100 }, now.toISOString()),
    );

    const reached = await gql<{ updateAsset: Valued }>(update, { id: asset?.id, input: { stock: { onHand: 2, reorderPoint: 2 } } });
    expect(reached.data?.updateAsset.stock).toEqual({ onHand: 2, reorderPoint: 2, belowReorderPoint: true });
    expect(await lows()).toBe(1);
    const event = await prisma.outboxEvent.findFirst({ where: { tenantId, type: 'openmap.asset.stock.low', subject: asset?.id } });
    expect((event?.envelope as { data?: unknown }).data).toMatchObject({ onHand: 2, reorderPoint: 2, by: 'tester' });
    // Staying below the reorder point is not news.
    await gql(update, { id: asset?.id, input: { stock: { onHand: 1, reorderPoint: 2 } } });
    expect(await lows()).toBe(1);

    const low = await gql<{ assets: Array<{ id: string; stock: { belowReorderPoint: boolean } | null }> }>(
      'query L($filter: AssetFilter) { assets(filter: $filter, first: 200) { id stock { belowReorderPoint } } }',
      { filter: { belowReorderPoint: true } },
    );
    expect(low.errors).toBeUndefined();
    expect(low.data?.assets.map((a) => a.id)).toContain(asset?.id);
    expect(low.data?.assets.every((a) => a.stock?.belowReorderPoint === true)).toBe(true);
    const summary = await gql<{ assetSummary: Array<{ layer: string; belowReorderPoint: number }> }>('query { assetSummary { layer belowReorderPoint } }');
    expect(summary.data?.assetSummary.find((r) => r.layer === 'dc')?.belowReorderPoint).toBeGreaterThanOrEqual(1);

    const invalid = await gql(update, { id: asset?.id, input: { depreciation: { method: 'straight_line', usefulLifeMonths: 0, residualValueAmount: 0 } } });
    expect(invalid.errors?.[0]?.message).toMatch(/updateAsset arguments|usefulLifeMonths/);
    // Stopping stock control clears it.
    const cleared = await gql<{ updateAsset: Valued }>(update, { id: asset?.id, input: { stock: null } });
    expect(cleared.data?.updateAsset.stock).toBeNull();
  });

  it('receives goods against a plan line: units into stock with serials, the line counted, the receipt kept, the plan building (REQ-CMDB-020)', async () => {
    // T-176 ADR-034
    const stamp = String(Date.now());
    type Line = { position: number; quantity: number; received: number; outstanding: number };
    type PlanShape = { id: string; number: string; status: string; owner: string; description: string; bom: Line[] };
    const created = await gql<{ createPlan: PlanShape }>(
      'mutation P($input: PlanInput!) { createPlan(input: $input) { id number status owner description bom { position quantity received outstanding } } }',
      {
        input: {
          name: 'Edge expansion ' + stamp,
          description: 'Two hosts and a switch for the edge pod',
          kind: 'stack_expansion',
          bom: [
            { description: 'Edge host', manufacturer: 'Dell', model: 'R660', layer: 'hardware', quantity: 3, unitCostAmount: 38_000, unitCostCurrency: 'SAR' },
            { description: 'Edge switch', manufacturer: 'Arista', model: '7010', layer: 'network_security', quantity: 1 },
          ],
        },
      },
    );
    expect(created.errors).toBeUndefined();
    const plan = created.data?.createPlan;
    expect(plan?.bom.map((l) => [l.position, l.outstanding])).toEqual([[0, 3], [1, 1]]);
    expect(plan?.description).toBe('Two hosts and a switch for the edge pod');
    const lineIds = await prisma.assetRecord.findMany({ where: { tenantId, planId: plan?.id }, select: { bomLineId: true } });
    expect(lineIds.every((a) => a.bomLineId !== null)).toBe(true);

    const receive = 'mutation R($input: ReceiptInput!) { receivePlanLine(input: $input) { id position description quantity receivedOn receivedBy reference location { id } assets { id assetTag serialNumber stage purchasedAt } } }';
    const today = new Date().toISOString().slice(0, 'YYYY-MM-DD'.length);
    const units = [
      { serialNumber: 'EDGE-' + stamp + '-A', assetTag: 'TAG-' + stamp + '-A' },
      { serialNumber: 'EDGE-' + stamp + '-B' },
    ];
    const draft = await gql(receive, { input: { planId: plan?.id, position: 0, receivedOn: today, units } });
    expect(draft.errors?.[0]?.message).toMatch(/approved or building/);
    await gql('mutation A($id: UUID!) { setPlanStatus(planId: $id, status: approved) { status } }', { id: plan?.id });

    const tooMany = await gql(receive, {
      input: { planId: plan?.id, position: 1, receivedOn: today, units: [{ serialNumber: 'SW-' + stamp + '-1' }, { serialNumber: 'SW-' + stamp + '-2' }] },
    });
    expect(tooMany.errors?.[0]?.message).toMatch(/1 units outstanding/);
    const repeated = await gql(receive, {
      input: { planId: plan?.id, position: 0, receivedOn: today, units: [{ serialNumber: 'DUP-' + stamp }, { serialNumber: 'DUP-' + stamp }] },
    });
    expect(repeated.errors?.[0]?.message).toMatch(/more than once/);
    const viewer = await gql(receive, { input: { planId: plan?.id, position: 0, receivedOn: today, units } }, viewerToken);
    expect(viewer.errors?.[0]?.message).toMatch(/roles/i);

    type Receipt = {
      id: string;
      position: number;
      description: string;
      quantity: number;
      receivedOn: string;
      receivedBy: string;
      reference: string | null;
      location: { id: string } | null;
      assets: Array<{ id: string; assetTag: string; serialNumber: string | null; stage: string; purchasedAt: string | null }>;
    };
    const received = await gql<{ receivePlanLine: Receipt }>(receive, {
      input: { planId: plan?.id, position: 0, receivedOn: today, reference: 'PO-' + stamp, locationId: ids.pdu, units },
    });
    expect(received.errors).toBeUndefined();
    const receipt = received.data?.receivePlanLine;
    expect(receipt).toMatchObject({ position: 0, description: 'Edge host', quantity: 2, reference: 'PO-' + stamp, location: { id: ids.pdu } });
    expect(receipt?.receivedOn.slice(0, 'YYYY-MM-DD'.length)).toBe(today);
    expect(receipt?.assets.map((a) => a.serialNumber).sort()).toEqual(units.map((u) => u.serialNumber).sort());
    expect(receipt?.assets.every((a) => a.stage === 'in_stock' && a.purchasedAt?.startsWith(today) === true)).toBe(true);
    expect(receipt?.assets.map((a) => a.assetTag)).toContain('TAG-' + stamp + '-A');

    const after = await gql<{ plans: Array<PlanShape & { receipts: Array<{ id: string; quantity: number }> }> }>(
      '{ plans(status: [building]) { id number status owner description bom { position quantity received outstanding } receipts { id quantity } } }',
    );
    const building = after.data?.plans.find((p) => p.id === plan?.id);
    expect(building?.status).toBe('building');
    expect(building?.bom.map((l) => [l.received, l.outstanding])).toEqual([[2, 1], [0, 1]]);
    expect(building?.receipts).toEqual([{ id: receipt?.id, quantity: 2 }]);

    const clash = await gql(receive, { input: { planId: plan?.id, position: 0, receivedOn: today, units: [{ serialNumber: units[0]?.serialNumber }] } });
    expect(clash.errors?.[0]?.message).toMatch(/already in the register/);

    const unitAudits = await prisma.assetAudit.findMany({ where: { tenantId, assetId: receipt?.assets[0]?.id }, select: { field: true, note: true } });
    expect(unitAudits.map((a) => a.field)).toEqual(expect.arrayContaining(['stage', 'serialNumber', 'purchasedAt', 'locationCiId']));
    expect(unitAudits.some((a) => a.note === 'received under PO-' + stamp)).toBe(true);
    const lineEvent = await prisma.outboxEvent.findFirst({ where: { tenantId, type: 'openmap.plan.line.received', subject: plan?.id } });
    expect((lineEvent?.envelope as { data: Record<string, unknown> } | undefined)?.data).toMatchObject({ position: 0, quantity: 2, outstanding: 1, reference: 'PO-' + stamp });
    expect(await prisma.outboxEvent.count({ where: { tenantId, type: 'openmap.plan.status.changed', subject: plan?.id } })).toBe(3);
    expect(
      await prisma.outboxEvent.count({ where: { tenantId, type: 'openmap.asset.stage.changed', subject: { in: receipt?.assets.map((a) => a.id) ?? [] } } }),
    ).toBe(4);
  });
  it('keeps the commercial register: vendors with contacts, cost centres, contracts with documents, and assets covered by their contract (REQ-CMDB-026..029)', async () => {
    // T-182 ADR-035
    const stamp = String(Date.now());
    const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 'YYYY-MM-DD'.length);
    const vendorRes = await gql<{ upsertVendor: { ci: { id: string; type: string }; category: string } }>(
      'mutation V($input: VendorInput!) { upsertVendor(input: $input) { ci { id type } category } }',
      { input: { name: 'Vendor ' + stamp, category: 'hardware', supportPortal: 'https://support.example.org' } },
    );
    expect(vendorRes.errors).toBeUndefined();
    const vendorId = vendorRes.data?.upsertVendor.ci.id ?? '';
    expect(vendorRes.data?.upsertVendor.ci.type).toBe('vendor');
    const denied = await gql('mutation V($input: VendorInput!) { upsertVendor(input: $input) { ci { id } } }', { input: { name: 'Viewer ' + stamp } }, viewerToken);
    expect(denied.errors?.[0]?.message).toMatch(/roles/i);
    const duplicate = await gql('mutation V($input: VendorInput!) { upsertVendor(input: $input) { ci { id } } }', { input: { name: 'Vendor ' + stamp } });
    expect(duplicate.errors?.[0]?.message).toMatch(/already exists/);

    const contact = 'mutation C($input: VendorContactInput!) { upsertVendorContact(input: $input) { id name escalationLevel } }';
    await gql(contact, { input: { vendorId, name: 'Duty manager', role: 'Escalation', escalationLevel: 2, phone: '+966 11 000 0000' } });
    await gql(contact, { input: { vendorId, name: 'Support desk', role: 'First line', escalationLevel: 1, email: 'desk@example.org', availability: '24x7' } });
    const badEmail = await gql(contact, { input: { vendorId, name: 'Bad', role: 'x', escalationLevel: 1, email: 'not-an-email' } });
    expect(badEmail.errors?.[0]?.message).toMatch(/invalid VendorContactInput/);

    const centreRes = await gql<{ upsertCostCentre: { ci: { id: string }; code: string; kind: string; annualBudget: { amount: number; currency: string } } }>(
      'mutation CC($input: CostCentreInput!) { upsertCostCentre(input: $input) { ci { id } code kind annualBudget { amount currency } } }',
      { input: { code: 'CC-' + stamp, name: 'Payments ' + stamp, kind: 'department', owner: 'Payments', annualBudget: 1_000_000, currency: 'SAR' } },
    );
    expect(centreRes.errors).toBeUndefined();
    expect(centreRes.data?.upsertCostCentre).toMatchObject({ code: 'CC-' + stamp, kind: 'department', annualBudget: { amount: 1_000_000, currency: 'SAR' } });
    const centreId = centreRes.data?.upsertCostCentre.ci.id ?? '';

    type Contract = {
      ci: { id: string };
      kind: string;
      contractNumber: string;
      title: string;
      daysToEnd: number;
      noticeBy: string;
      expired: boolean;
      annualCost: { amount: number; currency: string };
      coveredAssets: number;
      vendor: { id: string } | null;
      costCentre: { id: string } | null;
      documents: Array<{ title: string; location: string }>;
    };
    const contractFields = 'ci { id } kind contractNumber title daysToEnd noticeBy expired annualCost { amount currency } coveredAssets vendor { id } costCentre { id } documents { title location }';
    const contractInput = {
      vendorId,
      costCentreId: centreId,
      contractNumber: 'SUP-' + stamp,
      kind: 'support',
      title: 'Premium support ' + stamp,
      level: 'four_hour',
      responseMinutes: 240,
      startsAt: day(-335),
      endsAt: day(30),
      autoRenews: false,
      noticeDays: 10,
      annualCost: 50_000,
      currency: 'SAR',
      documents: [{ title: 'Signed agreement', location: 'https://dms.example.org/' + stamp + '.pdf' }],
    };
    const upsert = 'mutation U($id: UUID, $input: ContractInput!) { upsertContract(id: $id, input: $input) { ' + contractFields + ' } }';
    const created = await gql<{ upsertContract: Contract }>(upsert, { input: contractInput });
    expect(created.errors).toBeUndefined();
    const contract = created.data?.upsertContract;
    expect(contract).toMatchObject({
      kind: 'support',
      contractNumber: 'SUP-' + stamp,
      daysToEnd: 30,
      expired: false,
      annualCost: { amount: 50_000, currency: 'SAR' },
      coveredAssets: 0,
      vendor: { id: vendorId },
      costCentre: { id: centreId },
      documents: contractInput.documents,
    });
    expect(contract?.noticeBy.slice(0, 'YYYY-MM-DD'.length)).toBe(day(20));
    const renumbered = await gql(upsert, { id: contract?.ci.id, input: { ...contractInput, contractNumber: 'OTHER-' + stamp } });
    expect(renumbered.errors?.[0]?.message).toMatch(/cannot change/);
    const backwards = await gql(upsert, { input: { ...contractInput, contractNumber: 'BAD-' + stamp, endsAt: day(-400) } });
    expect(backwards.errors?.[0]?.message).toMatch(/invalid upsertContract arguments/);
    const retitled = await gql<{ upsertContract: Contract }>(upsert, { id: contract?.ci.id, input: { ...contractInput, title: 'Premium support renewed ' + stamp, costCentreId: null } });
    expect(retitled.data?.upsertContract).toMatchObject({ title: 'Premium support renewed ' + stamp, costCentre: null });
    await gql(upsert, { id: contract?.ci.id, input: contractInput });

    // An asset covered by the contract: its support gap closes and the counts follow.
    type Asset = { id: string; ci: { id: string }; dataGaps: string[]; supportContract: { id: string; contractNumber: string; level: string; vendor: { id: string }; primaryContact: { name: string } | null } | null; ownerCostCentre: { id: string } | null };
    const assetFields = 'id ci { id } dataGaps supportContract { id contractNumber level vendor { id } primaryContact { name } } ownerCostCentre { id }';
    const made = await gql<{ createAsset: Asset }>('mutation A($input: ManualAssetInput!) { createAsset(input: $input) { ' + assetFields + ' } }', {
      input: { layer: 'hardware', type: 'host', name: 'Covered host ' + stamp, details: { serialNumber: 'COV-' + stamp } },
    });
    const asset = made.data?.createAsset;
    expect(asset?.dataGaps).toContain('support');
    const linked = await gql<{ setAssetContract: Asset }>('mutation L($a: UUID!, $c: UUID) { setAssetContract(assetId: $a, contractId: $c) { ' + assetFields + ' } }', {
      a: asset?.id,
      c: contract?.ci.id,
    });
    expect(linked.errors).toBeUndefined();
    expect(linked.data?.setAssetContract.supportContract).toMatchObject({
      id: contract?.ci.id,
      contractNumber: 'SUP-' + stamp,
      level: 'four_hour',
      vendor: { id: vendorId },
      primaryContact: { name: 'Support desk' },
    });
    expect(linked.data?.setAssetContract.dataGaps).not.toContain('support');
    const owned = await gql<{ updateAsset: Asset }>('mutation O($id: UUID!, $input: AssetDetailsInput!) { updateAsset(assetId: $id, input: $input) { ' + assetFields + ' } }', {
      id: asset?.id,
      input: { ownerCostCentreId: centreId },
    });
    expect(owned.data?.updateAsset.ownerCostCentre).toEqual({ id: centreId });
    const wrongOwner = await gql('mutation O($id: UUID!, $input: AssetDetailsInput!) { updateAsset(assetId: $id, input: $input) { id } }', { id: asset?.id, input: { ownerCostCentreId: vendorId } });
    expect(wrongOwner.errors?.[0]?.message).toMatch(/cost centre .* not found/);

    // A covered_by made through the generic relationship mutation gives a second asset the contract too.
    const second = await gql<{ createAsset: Asset }>('mutation A($input: ManualAssetInput!) { createAsset(input: $input) { ' + assetFields + ' } }', {
      input: { layer: 'hardware', type: 'host', name: 'Covered host 2 ' + stamp, details: { serialNumber: 'COV2-' + stamp } },
    });
    await gql('mutation Rel($from: UUID!, $to: UUID!) { createRelationship(type: "covered_by", fromCiId: $from, toCiId: $to, attributes: {}) { id } }', {
      from: second.data?.createAsset.ci.id,
      to: contract?.ci.id,
    });
    const secondRow = await prisma.assetRecord.findUnique({ where: { id: second.data?.createAsset.id }, select: { supportContractId: true } });
    expect(secondRow?.supportContractId).toBe(contract?.ci.id);

    type Register = {
      contracts: Contract[];
      expired: Contract[];
      vendor: { vendor: { contracts: number; activeContracts: number; coveredAssets: number; annualCost: { amount: number } | null; contacts: number }; contacts: Array<{ name: string; escalationLevel: number }>; contracts: Array<{ contractNumber: string }> };
      costCentres: Array<{ ci: { id: string }; contracts: number; annualContractCost: { amount: number } | null; assets: number }>;
    };
    const register = await gql<Register>(
      'query R($vendor: UUID!, $text: String) { contracts(filter: { expiringWithinDays: 60, text: $text }) { ' + contractFields + ' } expired: contracts(filter: { expired: true, text: $text }) { ' + contractFields + ' } vendor(id: $vendor) { vendor { contracts activeContracts coveredAssets annualCost { amount } contacts } contacts { name escalationLevel } contracts { contractNumber } } costCentres { ci { id } contracts annualContractCost { amount } assets } }',
      { vendor: vendorId, text: stamp },
    );
    expect(register.errors).toBeUndefined();
    expect(register.data?.contracts.map((c) => [c.contractNumber, c.coveredAssets])).toEqual([['SUP-' + stamp, 2]]);
    expect(register.data?.expired).toEqual([]);
    expect(register.data?.vendor.vendor).toEqual({ contracts: 1, activeContracts: 1, coveredAssets: 2, annualCost: { amount: 50_000 }, contacts: 2 });
    expect(register.data?.vendor.contacts.map((c) => c.name)).toEqual(['Support desk', 'Duty manager']);
    expect(register.data?.costCentres.find((c) => c.ci.id === centreId)).toMatchObject({ contracts: 1, annualContractCost: { amount: 50_000 }, assets: 1 });

    const unlinked = await gql<{ setAssetContract: Asset }>('mutation L($a: UUID!) { setAssetContract(assetId: $a, contractId: null) { ' + assetFields + ' } }', { a: asset?.id });
    expect(unlinked.data?.setAssetContract.supportContract).toBeNull();
    expect(unlinked.data?.setAssetContract.dataGaps).toContain('support');
    const after = await gql<{ contract: { coveredAssets: number } }>('query C($id: UUID!) { contract(id: $id) { coveredAssets } }', { id: contract?.ci.id });
    expect(after.data?.contract.coveredAssets).toBe(1);
    const audits = await prisma.assetAudit.findMany({ where: { tenantId, assetId: asset?.id, field: { in: ['supportContract', 'ownerCostCentreCiId'] } }, select: { field: true } });
    expect(audits.map((a) => a.field).sort()).toEqual(['ownerCostCentreCiId', 'supportContract', 'supportContract']);
  });
  it('moves a CI through its lifecycle, replaces its tags, lists tags and filters by both; viewers are refused', async () => {
    // T-161 REQ-CMDB-013 REQ-CMDB-016
    const lifecycle = 'mutation L($ciId: UUID!, $lifecycle: Lifecycle!) { setCiLifecycle(ciId: $ciId, lifecycle: $lifecycle) { id lifecycle } }';
    const managed = await gql<{ setCiLifecycle: { lifecycle: string } }>(lifecycle, { ciId: ids.host, lifecycle: 'managed' });
    expect(managed.errors).toBeUndefined();
    expect(managed.data?.setCiLifecycle.lifecycle).toBe('managed');
    const tags = 'mutation T($ciId: UUID!, $tags: [String!]!) { setCiTags(ciId: $ciId, tags: $tags) { id tags } }';
    const tagged = await gql<{ setCiTags: { tags: string[] } }>(tags, { ciId: ids.host, tags: ['pci', ' ledger ', 'pci', 'مالية'] });
    expect(tagged.errors).toBeUndefined();
    expect(tagged.data?.setCiTags.tags).toEqual(['ledger', 'pci', 'مالية']);
    const bad = await gql<{ setCiTags: unknown }>(tags, { ciId: ids.host, tags: ['has space'] });
    expect(bad.errors?.[0]?.message).toMatch(/tags/i);
    const list = await gql<{ ciTags: Array<{ tag: string; count: number }> }>('query { ciTags { tag count } }');
    expect(list.data?.ciTags).toEqual(expect.arrayContaining([{ tag: 'pci', count: 1 }]));
    const filtered = await gql<{ cis: { edges: Array<{ node: { id: string } }> } }>(
      'query F($filter: CiFilter) { cis(filter: $filter, first: 10) { edges { node { id } } } }',
      { filter: { tags: ['pci'], lifecycle: ['managed'] } },
    );
    expect(filtered.data?.cis.edges.map((e) => e.node.id)).toEqual([ids.host]);
    const audit = await prisma.outboxEvent.findFirst({ where: { tenantId, type: 'openmap.ci.updated', subject: ids.host }, orderBy: { createdAt: 'desc' } });
    expect((audit?.envelope as { data?: { changed?: string[]; ci?: { tags?: string[] } } }).data).toMatchObject({ changed: ['tags'], ci: { tags: ['ledger', 'pci', 'مالية'] } });
    const denied = await gql<{ setCiLifecycle: unknown }>(lifecycle, { ciId: ids.host, lifecycle: 'retired' }, viewerToken);
    expect(denied.errors?.[0]?.message).toMatch(/roles/i);
    await gql(tags, { ciId: ids.host, tags: [] });
  });

  it('defines custom fields, sets and validates values on a CI, filters by them and clears them on delete', async () => {
    // T-165 REQ-CMDB-015
    const adminToken = await mint([ROLES.admin], keys.privateKey);
    const upsert = 'mutation U($id: UUID, $input: CustomFieldDefinitionInput!) { upsertCustomFieldDefinition(id: $id, input: $input) { id key type options appliesTo required usage } }';
    const owner = await gql<{ upsertCustomFieldDefinition: { id: string } }>(upsert, { input: { key: 'businessOwner', labelEn: 'Business owner', labelAr: 'مالك الأعمال', type: 'text' } }, adminToken);
    expect(owner.errors).toBeUndefined();
    const tier = await gql<{ upsertCustomFieldDefinition: { id: string; options: string[] } }>(
      upsert,
      { input: { key: 'dataTier', labelEn: 'Data tier', labelAr: 'فئة البيانات', type: 'select', options: ['gold', 'silver'], appliesTo: ['host'] } },
      adminToken,
    );
    expect(tier.data?.upsertCustomFieldDefinition.options).toEqual(['gold', 'silver']);
    const byOperator = await gql<{ upsertCustomFieldDefinition: unknown }>(upsert, { input: { key: 'nope', labelEn: 'x', labelAr: 'x', type: 'text' } });
    expect(byOperator.errors?.[0]?.message).toMatch(/roles/i);
    const dup = await gql<{ upsertCustomFieldDefinition: unknown }>(upsert, { input: { key: 'businessOwner', labelEn: 'x', labelAr: 'x', type: 'text' } }, adminToken);
    expect(dup.errors?.[0]?.message).toContain('already exists');
    const rekey = await gql<{ upsertCustomFieldDefinition: unknown }>(upsert, { id: owner.data?.upsertCustomFieldDefinition.id, input: { key: 'renamed', labelEn: 'x', labelAr: 'x', type: 'text' } }, adminToken);
    expect(rekey.errors?.[0]?.message).toContain('cannot change');

    const forHost = await gql<{ customFieldDefinitions: Array<{ key: string }> }>('query { customFieldDefinitions(type: "host") { key } }');
    expect(forHost.data?.customFieldDefinitions.map((d) => d.key)).toEqual(['businessOwner', 'dataTier']);
    const forDb = await gql<{ customFieldDefinitions: Array<{ key: string }> }>('query { customFieldDefinitions(type: "database_cluster") { key } }');
    expect(forDb.data?.customFieldDefinitions.map((d) => d.key)).toEqual(['businessOwner']);

    const set = 'mutation S($ciId: UUID!, $values: JSON!) { setCiCustomFields(ciId: $ciId, values: $values) { id customFields } }';
    const ok = await gql<{ setCiCustomFields: { customFields: Record<string, unknown> } }>(set, { ciId: ids.host, values: { businessOwner: ' Treasury ', dataTier: 'gold' } });
    expect(ok.errors).toBeUndefined();
    expect(ok.data?.setCiCustomFields.customFields).toEqual({ businessOwner: 'Treasury', dataTier: 'gold' });
    const badValue = await gql<{ setCiCustomFields: unknown }>(set, { ciId: ids.host, values: { dataTier: 'bronze' } });
    expect(badValue.errors?.[0]?.message).toContain('dataTier expects one of gold, silver');
    const wrongType = await gql<{ setCiCustomFields: unknown }>(set, { ciId: ids.db, values: { dataTier: 'gold' } });
    expect(wrongType.errors?.[0]?.message).toContain('no custom field');
    const viewer = await gql<{ setCiCustomFields: unknown }>(set, { ciId: ids.host, values: { businessOwner: 'x' } }, viewerToken);
    expect(viewer.errors?.[0]?.message).toMatch(/roles/i);

    const filtered = await gql<{ cis: { edges: Array<{ node: { id: string } }> } }>(
      'query F($filter: CiFilter) { cis(filter: $filter, first: 10) { edges { node { id } } } }',
      { filter: { customFields: { dataTier: 'gold' } } },
    );
    expect(filtered.data?.cis.edges.map((e) => e.node.id)).toEqual([ids.host]);
    const usage = await gql<{ customFieldDefinitions: Array<{ key: string; usage: number }> }>('query { customFieldDefinitions { key usage } }');
    expect(usage.data?.customFieldDefinitions).toEqual(expect.arrayContaining([{ key: 'dataTier', usage: 1 }]));

    const del = await gql<{ deleteCustomFieldDefinition: boolean }>('mutation D($id: UUID!) { deleteCustomFieldDefinition(id: $id) }', { id: tier.data?.upsertCustomFieldDefinition.id }, adminToken);
    expect(del.data?.deleteCustomFieldDefinition).toBe(true);
    const after = await gql<{ ci: { customFields: Record<string, unknown> } }>('query C($id: UUID!) { ci(id: $id) { customFields } }', { id: ids.host });
    expect(after.data?.ci.customFields).toEqual({ businessOwner: 'Treasury' });
    await gql('mutation D($id: UUID!) { deleteCustomFieldDefinition(id: $id) }', { id: owner.data?.upsertCustomFieldDefinition.id }, adminToken);
  });

  it('lists discovery scopes from subnets and lets an operator set exclusions, credential set and rate limit', async () => {
    // T-112 REQ-DISC-029
    const scopes = await gql<{
      discoveryScopes: Array<{
        ci: { id: string };
        cidr: string;
        exclusions: string[];
        credentialType: string;
      }>;
    }>('{ discoveryScopes { ci { id } cidr exclusions credentialType } }');
    expect(scopes.errors).toBeUndefined();
    const scope = scopes.data?.discoveryScopes.find((s) => s.ci.id === ids.subnet);
    expect(scope).toEqual({
      ci: { id: ids.subnet },
      cidr: '10.42.0.0/29',
      exclusions: [],
      credentialType: 'none',
    });
    const mutation =
      'mutation Scope($ciId: UUID!, $input: DiscoveryScopeInput!) { updateDiscoveryScope(ciId: $ciId, input: $input) { cidr exclusions credentialRef credentialType rateLimitConcurrency rateLimitRps } }';
    const updated = await gql<{
      updateDiscoveryScope: {
        cidr: string;
        exclusions: string[];
        credentialRef: string | null;
        credentialType: string;
        rateLimitConcurrency: number | null;
        rateLimitRps: number | null;
      };
    }>(mutation, {
      ciId: ids.subnet,
      input: {
        exclusions: ['10.42.0.4/30'],
        credentialRef: 'secret/openmap/snmp-core',
        credentialType: 'snmp_v3',
        rateLimitConcurrency: 4,
        rateLimitRps: 50,
      },
    });
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.updateDiscoveryScope).toEqual({
      cidr: '10.42.0.0/29',
      exclusions: ['10.42.0.4/30'],
      credentialRef: 'secret/openmap/snmp-core',
      credentialType: 'snmp_v3',
      rateLimitConcurrency: 4,
      rateLimitRps: 50,
    });
    const again = await gql<{
      discoveryScopes: Array<{ ci: { id: string }; exclusions: string[]; rateLimitRps: number | null }>;
    }>('{ discoveryScopes { ci { id } exclusions rateLimitRps } }');
    expect(again.data?.discoveryScopes.find((s) => s.ci.id === ids.subnet)).toEqual({
      ci: { id: ids.subnet },
      exclusions: ['10.42.0.4/30'],
      rateLimitRps: 50,
    });
    const malformed = await gql<{ updateDiscoveryScope: unknown }>(mutation, {
      ciId: ids.subnet,
      input: { exclusions: ['not-a-cidr'] },
    });
    expect(malformed.errors?.[0]?.message).toMatch(/updateDiscoveryScope arguments/);
    const denied = await gql<{ updateDiscoveryScope: unknown }>(
      mutation,
      { ciId: ids.subnet, input: { rateLimitRps: 1 } },
      viewerToken,
    );
    expect(denied.errors?.[0]?.message).toMatch(/roles/i);
  });

  it('runs the initial setup end to end: organization, site CI, link CI, Node token, vault credential, scope and twin (REQ-UI-024)', async () => {
    type Onboarding = {
      onboarding: {
        organization: {
          id: string;
          name: string;
          businessUnits: Array<{ tenantId: string; name: string; slug: string }>;
        };
        step: string;
        completedSteps: string[];
        sites: Array<{
          id: string;
          code: string;
          ci: { id: string; code: string; type: string } | null;
          nodes: Array<{ id: string; status: string }>;
        }>;
        links: Array<{ id: string; ci: { type: string } | null }>;
        credentials: Array<{ ref: string; type: string; fields: string[] }>;
        scopes: Array<{
          cidr: string;
          credentialRef: string | null;
          credentialType: string;
          site: { id: string } | null;
        }>;
        generatedAt: string | null;
        firstSweep: { id: string } | null;
        schedulerUrl: string;
      };
    };
    const stateQuery =
      'query { onboarding { organization { id name businessUnits { tenantId name slug } } step completedSteps sites { id code ci { id code type } nodes { id status } } links { id ci { type } } credentials { ref type fields } scopes { cidr credentialRef credentialType site { id } } generatedAt firstSweep { id } schedulerUrl } }';
    // The setup mutations are administrator-only; the operator token used by the other tests must be refused.
    const operatorOnly = operatorToken;
    const refusedOperator = await gql<{ generateTwin: unknown }>(
      'mutation { generateTwin { step } }',
      {},
      operatorOnly,
    );
    expect(refusedOperator.errors?.[0]?.message).toContain(ROLES.admin);
    operatorToken = await mint([ROLES.admin], keys.privateKey);
    const initial = await gql<Onboarding>(stateQuery);
    expect(initial.errors).toBeUndefined();
    expect(initial.data?.onboarding.organization.id).toBe(organizationId);
    expect(initial.data?.onboarding.step).toBe('organization');
    expect(initial.data?.onboarding.organization.businessUnits.map((u) => u.tenantId)).toContain(tenantId);
    expect(initial.data?.onboarding.schedulerUrl).toBe(env.PUBLIC_SCHEDULER_URL);

    // Organization: rename, keep the signed-in unit, add one (a new tenant with a derived slug); viewers are refused.
    const orgMutation =
      'mutation($input: OrganizationInput!) { updateOrganization(input: $input) { name industry businessUnits { tenantId name slug } } }';
    const orgInput = {
      name: 'Horizon Bank',
      industry: 'Banking',
      timeZone: 'Asia/Riyadh',
      defaultLocale: 'en',
      regulatoryScope: ['SAMA CSF'],
      airGapped: true,
      businessUnits: [
        { tenantId, name: 'Group Technology' },
        { tenantId: null, name: 'Retail Banking' },
      ],
    };
    const denied = await gql<{ updateOrganization: unknown }>(orgMutation, { input: orgInput }, viewerToken);
    expect(denied.errors?.[0]?.message).toMatch(/forbidden|role/i);
    const org = await gql<{
      updateOrganization: {
        name: string;
        businessUnits: Array<{ tenantId: string; name: string; slug: string }>;
      };
    }>(orgMutation, { input: orgInput });
    expect(org.errors).toBeUndefined();
    expect(org.data?.updateOrganization.name).toBe('Horizon Bank');
    const retail = org.data?.updateOrganization.businessUnits.find((u) => u.name === 'Retail Banking');
    expect(retail?.slug).toBe('retail-banking');
    expect(org.data?.updateOrganization.businessUnits.find((u) => u.tenantId === tenantId)?.name).toBe(
      'Group Technology',
    );

    // Sites: saving creates the site CI (identity = code) through the outbox; the code cannot change; duplicates are refused.
    const siteMutation =
      'mutation($id: UUID, $input: SiteInput!) { upsertSite(id: $id, input: $input) { id code name ci { id code type } } }';
    const siteInput = {
      code: 'ryd',
      name: 'Riyadh DC',
      kind: 'datacenter',
      tier: 3,
      address: 'King Fahd Rd',
      city: 'Riyadh',
      countryCode: 'sa',
      geo: { lat: 24.7, lon: 46.7 },
      cloud: null,
      locationCount: 1,
      facility: { powerCapacityKw: 800, rackCount: 40, designPue: 1.4 },
    };
    const ryd = await gql<{
      upsertSite: { id: string; code: string; ci: { id: string; code: string; type: string } };
    }>(siteMutation, { id: null, input: siteInput });
    expect(ryd.errors).toBeUndefined();
    expect(ryd.data?.upsertSite.code).toBe('RYD');
    expect(ryd.data?.upsertSite.ci.type).toBe('site');
    const siteCi = await prisma.ci.findUnique({ where: { id: ryd.data?.upsertSite.ci.id } });
    expect(siteCi?.identityKey).toBe('ryd');
    expect(siteCi?.sourceCollectorId).toBe('api');
    expect(
      await prisma.outboxEvent.count({
        where: { tenantId, type: 'openmap.ci.created', subject: siteCi?.id },
      }),
    ).toBe(1);
    const duplicate = await gql<{ upsertSite: unknown }>(siteMutation, {
      id: null,
      input: { ...siteInput, name: 'Other' },
    });
    expect(duplicate.errors?.[0]?.message).toContain('already used');
    const renamed = await gql<{ upsertSite: unknown }>(siteMutation, {
      id: ryd.data?.upsertSite.id,
      input: { ...siteInput, code: 'RYD2' },
    });
    expect(renamed.errors?.[0]?.message).toContain('cannot change');
    const updated = await gql<{ upsertSite: { ci: { id: string } } }>(siteMutation, {
      id: ryd.data?.upsertSite.id,
      input: { ...siteInput, facility: { powerCapacityKw: 900, rackCount: 40, designPue: 1.4 } },
    });
    expect(updated.data?.upsertSite.ci.id).toBe(ryd.data?.upsertSite.ci.id);
    const dmm = await gql<{ upsertSite: { id: string } }>(siteMutation, {
      id: null,
      input: { ...siteInput, code: 'DMM', name: 'Dammam DR', city: 'Dammam' },
    });
    expect(dmm.errors).toBeUndefined();
    const cloudMissing = await gql<{ upsertSite: unknown }>(siteMutation, {
      id: null,
      input: { ...siteInput, code: 'AZ1', kind: 'cloud_region', cloud: null },
    });
    expect(cloudMissing.errors?.[0]?.message).toContain('cloud region');

    // Link: a site_link CI connected to both site CIs.
    const linkMutation =
      'mutation($input: SiteLinkInput!) { upsertSiteLink(input: $input) { id fromSite { code } toSite { code } ci { id type } } }';
    const link = await gql<{
      upsertSiteLink: { id: string; fromSite: { code: string }; ci: { id: string; type: string } };
    }>(linkMutation, {
      input: {
        fromSiteId: ryd.data?.upsertSite.id,
        toSiteId: dmm.data?.upsertSite.id,
        kind: 'dwdm',
        provider: 'stc',
        circuitId: 'STC-DWDM-1',
        bandwidthMbps: 10000,
        diversePaths: 2,
        role: 'primary',
        latencyMs: 4.2,
      },
    });
    expect(link.errors).toBeUndefined();
    expect(link.data?.upsertSiteLink.ci.type).toBe('site_link');
    expect(
      await prisma.relationship.count({
        where: { tenantId, fromCiId: link.data?.upsertSiteLink.ci.id, type: 'connected_to', validTo: null },
      }),
    ).toBe(2);
    const selfLink = await gql<{ upsertSiteLink: unknown }>(linkMutation, {
      input: {
        fromSiteId: ryd.data?.upsertSite.id,
        toSiteId: ryd.data?.upsertSite.id,
        kind: 'mpls',
        bandwidthMbps: 100,
        diversePaths: 1,
        role: 'backup',
      },
    });
    expect(selfLink.errors?.[0]?.message).toContain('two different sites');

    // Node: pending with the digest of the one-time token, as the scheduler's enrol route expects.
    const registration = await gql<{
      registerNode: {
        node: { id: string; status: string };
        siteCode: string;
        enrolToken: string;
        schedulerUrl: string;
      };
    }>(
      'mutation($siteId: UUID!, $nodeId: String!) { registerNode(siteId: $siteId, nodeId: $nodeId) { node { id status } siteCode enrolToken schedulerUrl } }',
      { siteId: ryd.data?.upsertSite.id, nodeId: 'node-ryd-it-01' },
    );
    expect(registration.errors).toBeUndefined();
    expect(registration.data?.registerNode.enrolToken).toMatch(/^[a-f0-9]{64}$/);
    expect(registration.data?.registerNode.siteCode).toBe('RYD');
    const nodeRow = await prisma.discoveryNode.findUnique({ where: { id: 'node-ryd-it-01' } });
    expect(nodeRow?.status).toBe('pending');
    expect(nodeRow?.enrolTokenDigest).toBe(
      createHash('sha256')
        .update(registration.data?.registerNode.enrolToken ?? '')
        .digest('hex'),
    );

    // Credential set: written to OpenBao with its type; the API answers with field names only and refuses a wrong field.
    const credentialMutation =
      'mutation($input: CredentialSetInput!) { saveCredentialSet(input: $input) { ref type fields } }';
    const credentialRef = 'it/snmp-' + tenantId.slice(0, 8);
    const credential = await gql<{ saveCredentialSet: { ref: string; type: string; fields: string[] } }>(
      credentialMutation,
      { input: { ref: credentialRef, type: 'snmp_v2c', fields: { community: 'it-community' } } },
    );
    expect(credential.errors).toBeUndefined();
    expect(credential.data?.saveCredentialSet).toEqual({
      ref: credentialRef,
      type: 'snmp_v2c',
      fields: ['community'],
    });
    const vault = await fetch(
      new URL(
        'v1/' + env.OPENBAO_MOUNT + '/data/' + credentialRef,
        env.OPENBAO_ADDR.endsWith('/') ? env.OPENBAO_ADDR : env.OPENBAO_ADDR + '/',
      ),
      { headers: { 'X-Vault-Token': env.OPENBAO_TOKEN } },
    );
    expect(((await vault.json()) as { data: { data: Record<string, string> } }).data.data).toEqual({
      type: 'snmp_v2c',
      community: 'it-community',
    });
    const wrongField = await gql<{ saveCredentialSet: unknown }>(credentialMutation, {
      input: { ref: 'it/bad', type: 'password', fields: { username: 'x', password: 'y', community: 'z' } },
    });
    expect(wrongField.errors?.[0]?.message).toContain('invalid CredentialSetInput');
    const auditRow = await prisma.auditLog.findFirst({
      where: { tenantId, action: 'saveCredentialSet' },
      orderBy: { at: 'desc' },
    });
    expect(JSON.stringify(auditRow?.details)).not.toContain('it-community');

    // Scope: a subnet CI located at the site, carrying the credential; the same CIDR again updates instead of duplicating.
    const scopeMutation =
      'mutation($input: ScopeInput!) { addDiscoveryScope(input: $input) { ci { id } cidr credentialRef credentialType site { id } } }';
    const scope = await gql<{
      addDiscoveryScope: {
        ci: { id: string };
        cidr: string;
        credentialRef: string;
        credentialType: string;
        site: { id: string };
      };
    }>(scopeMutation, {
      input: {
        cidr: '10.77.0.0/24',
        vrf: null,
        siteId: ryd.data?.upsertSite.id,
        credentialRef,
        credentialType: 'snmp_v2c',
      },
    });
    expect(scope.errors).toBeUndefined();
    expect(scope.data?.addDiscoveryScope).toMatchObject({
      cidr: '10.77.0.0/24',
      credentialRef,
      credentialType: 'snmp_v2c',
      site: { id: ryd.data?.upsertSite.ci.id },
    });
    const again = await gql<{ addDiscoveryScope: { ci: { id: string } } }>(scopeMutation, {
      input: {
        cidr: '10.77.0.0/24',
        vrf: null,
        siteId: ryd.data?.upsertSite.id,
        credentialRef: null,
        credentialType: null,
      },
    });
    expect(again.data?.addDiscoveryScope.ci.id).toBe(scope.data?.addDiscoveryScope.ci.id);
    expect(
      await prisma.ci.count({
        where: { tenantId, type: 'subnet', identityKey: '10.77.0.0/24|default', validTo: null },
      }),
    ).toBe(1);

    // Steps and the twin: generate records the moment, completes every step and plans the first sweep.
    const stepped = await gql<{ setOnboardingStep: { step: string; completedSteps: string[] } }>(
      'mutation { setOnboardingStep(step: nodes_credentials, completed: true) { step completedSteps } }',
    );
    expect(stepped.data?.setOnboardingStep.completedSteps).toContain('nodes_credentials');
    const generated = await gql<{
      generateTwin: {
        generatedAt: string | null;
        completedSteps: string[];
        firstSweep: { id: string } | null;
        links: Array<{ ci: { type: string } | null }>;
      };
    }>('mutation { generateTwin { generatedAt completedSteps firstSweep { id } links { ci { type } } } }');
    expect(generated.errors).toBeUndefined();
    expect(generated.data?.generateTwin.generatedAt).not.toBeNull();
    expect(generated.data?.generateTwin.completedSteps).toHaveLength(6);
    expect(generated.data?.generateTwin.firstSweep?.id).toBeTruthy();
    const final = await gql<Onboarding>(stateQuery);
    expect(final.data?.onboarding.sites.map((s) => s.code).sort()).toEqual(['DMM', 'RYD']);
    expect(final.data?.onboarding.sites.find((s) => s.code === 'RYD')?.nodes.map((n) => n.id)).toEqual([
      'node-ryd-it-01',
    ]);
    expect(final.data?.onboarding.credentials).toEqual([
      { ref: credentialRef, type: 'snmp_v2c', fields: ['community'] },
    ]);

    // Removal: a site with a Node is refused; the link and the empty site go, retiring their CIs.
    const refused = await gql<{ removeSite: boolean }>('mutation($id: UUID!) { removeSite(id: $id) }', {
      id: ryd.data?.upsertSite.id,
    });
    expect(refused.errors?.[0]?.message).toContain('Nodes and links');
    const linkGone = await gql<{ removeSiteLink: boolean }>(
      'mutation($id: UUID!) { removeSiteLink(id: $id) }',
      { id: link.data?.upsertSiteLink.id },
    );
    expect(linkGone.data?.removeSiteLink).toBe(true);
    expect(
      (await prisma.ci.findUnique({ where: { id: link.data?.upsertSiteLink.ci.id } }))?.validTo,
    ).not.toBeNull();
    const siteGone = await gql<{ removeSite: boolean }>('mutation($id: UUID!) { removeSite(id: $id) }', {
      id: dmm.data?.upsertSite.id,
    });
    expect(siteGone.data?.removeSite).toBe(true);
    operatorToken = operatorOnly;
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
