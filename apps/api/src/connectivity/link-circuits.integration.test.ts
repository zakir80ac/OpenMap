// T-592 REQ-IPAM-007 (ADR-069) — the network circuit register against the compose stack, in a tenant of its own:
// - setup records two sites and a link with its carrier contract, committed latency and physical route; the record and
//   the site_link CI both carry them;
// - two carrier circuits are recorded (ADR-056); saveLinkCircuit (GraphQL, as an operator) puts the link on both: the
//   CI carries the register's attributes, each circuit is a depends_on relationship from the link, the setup record
//   follows, and the change is audited;
// - saving again with one circuit retires the other edge and keeps the first; a CI that is not a circuit is refused, and
//   so is a link id that is not a link;
// - a backup link on the same carrier and circuit shows both shared risks, on both links, in Query.connectivity;
// - once the reconciler has written the outbox to Memgraph, the impact walk upstream from the shared circuit reaches
//   both links: a circuit outage is modelled like any component's.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import { loadEnv } from '@openmap/config';
import { LINK_CIRCUIT_RELATIONSHIP } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { createGraphRepository } from '@openmap/graph';
import { AppModule } from '../app.module.js';
import { JWKS, realmUrl } from '../auth/jwks.provider.js';
import { SIGNING_ALGORITHM } from '../auth/auth.service.js';
import { ROLES } from '../auth/roles.js';
import { CablingService } from '../cabling/cabling.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const graph = createGraphRepository(env);
const KID = 'openmap-link-circuits-key';
const TIMEOUT_MS = 180_000;
const POLL_MS = 500;
const organizationId = randomUUID();
const tenantId = randomUUID();
const stamp = tenantId.slice(0, 6).toUpperCase();
const ACTOR = 'circuits-itest';
let app: NestFastifyApplication;
let keys: GenerateKeyPairResult;

async function token(): Promise<string> {
  return new SignJWT({
    tenant: tenantId,
    preferred_username: ACTOR,
    realm_access: { roles: [ROLES.operator] },
    azp: env.KEYCLOAK_CLIENT_ID,
  })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: KID })
    .setIssuer(realmUrl(env).toString())
    .setSubject('circuits-' + randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await token()) },
    payload: { query, variables },
  });
  const body = JSON.parse(res.body) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors !== undefined) throw new Error(body.errors.map((e) => e.message).join('; '));
  if (body.data === undefined) throw new Error('no data');
  return body.data;
}

async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const v = await read();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

interface LinkView {
  ci: { id: string; displayName: string };
  provider: string | null;
  role: string | null;
  carrierContractRef: string | null;
  pathRef: string | null;
  slaLatencyMs: number | null;
  capacityMbps: number | null;
  circuits: Array<{
    ci: { id: string };
    provider: string | null;
    circuitId: string | null;
    status: string | null;
  }>;
  sharedRisks: Array<{ kind: string; value: string; other: { id: string } | null }>;
}
const LINK_FIELDS =
  'ci { id displayName } provider role carrierContractRef pathRef slaLatencyMs capacityMbps circuits { ci { id } provider circuitId status } sharedRisks { kind value other { id } }';
const SAVE =
  'mutation S($linkId: UUID!, $input: LinkCircuitInput!) { saveLinkCircuit(linkId: $linkId, input: $input) { ' +
  LINK_FIELDS +
  ' } }';
const CONNECTIVITY = 'query { connectivity { links { ' + LINK_FIELDS + ' } } }';

describe('network circuit register (integration)', () => {
  beforeAll(async () => {
    keys = await generateKeyPair(SIGNING_ALGORITHM);
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: SIGNING_ALGORITHM, use: 'sig' };
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
        name: 'Circuits org',
        industry: 'test',
        timeZone: 'UTC',
        defaultLocale: 'en',
        regulatoryScope: [],
        airGapped: true,
      },
    });
    await prisma.tenant.create({
      data: { id: tenantId, organizationId, name: 'Circuits BU', slug: 'circuits-' + tenantId.slice(0, 8) },
    });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await graph.purgeTenant(tenantId);
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await graph.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it(
    'records circuits under links, shows shared risks and walks a circuit outage to the links',
    async () => {
      const actor = { tenantId, username: ACTOR, requestId: randomUUID() };
      const setup = app.get(OnboardingService);
      const site = (code: string) =>
        setup.upsertSite(actor, null, {
          code,
          name: code + ' DC',
          kind: 'datacenter',
          address: '',
          city: code,
          countryCode: 'SA',
          locationCount: 1,
        });
      const ryd = await site('C' + stamp.slice(0, 3) + 'R');
      const jed = await site('C' + stamp.slice(0, 3) + 'J');
      const created = await setup.upsertSiteLink(actor, null, {
        fromSiteId: ryd.id,
        toSiteId: jed.id,
        kind: 'dark_fibre',
        provider: 'stc',
        circuitId: 'DF-' + stamp,
        bandwidthMbps: 100_000,
        diversePaths: 1,
        role: 'primary',
        carrierContractRef: 'CTR-STC-001',
        slaLatencyMs: 15,
        pathRef: 'North duct',
      });
      expect(created).toMatchObject({
        carrierContractRef: 'CTR-STC-001',
        slaLatencyMs: 15,
        pathRef: 'North duct',
      });
      const linkCi = created.ciId ?? '';
      const linkRow = await prisma.ci.findUniqueOrThrow({ where: { id: linkCi } });
      expect(linkRow.attributes).toMatchObject({
        carrierContractRef: 'CTR-STC-001',
        slaLatencyMs: 15,
        pathRef: 'North duct',
      });

      const cabling = app.get(CablingService);
      const circuit = (id: string, kind: 'dark_fibre' | 'mpls') =>
        cabling.upsertCircuit(tenantId, ACTOR, null, {
          provider: 'stc',
          circuitId: id,
          kind,
          status: 'active',
          bandwidthMbps: 100_000,
          aEnd: null,
          zEnd: null,
          zEndDescription: 'stc POP',
        });
      const loop = await circuit('LOOP-' + stamp, 'dark_fibre');
      const backbone = await circuit('BB-' + stamp, 'mpls');

      const input = {
        kind: 'dark_fibre',
        provider: 'stc',
        carrierContractRef: 'CTR-STC-002',
        bandwidthMbps: 40_000,
        slaLatencyMs: 12,
        diversePaths: 1,
        role: 'primary',
        pathRef: 'North duct',
        circuitCiIds: [loop.ci.id, backbone.ci.id],
      };
      const saved = (await gql<{ saveLinkCircuit: LinkView }>(SAVE, { linkId: linkCi, input }))
        .saveLinkCircuit;
      expect(saved).toMatchObject({
        provider: 'stc',
        carrierContractRef: 'CTR-STC-002',
        pathRef: 'North duct',
        slaLatencyMs: 12,
        capacityMbps: 40_000,
        sharedRisks: [],
      });
      expect(saved.circuits.map((c) => c.ci.id).sort()).toEqual([loop.ci.id, backbone.ci.id].sort());
      expect(saved.circuits.every((c) => c.provider === 'stc' && c.status === 'active')).toBe(true);
      const edges = () =>
        prisma.relationship.findMany({
          where: { tenantId, fromCiId: linkCi, type: LINK_CIRCUIT_RELATIONSHIP, validTo: null },
        });
      expect((await edges()).map((r) => r.toCiId).sort()).toEqual([loop.ci.id, backbone.ci.id].sort());
      const record = await prisma.siteLink.findUniqueOrThrow({ where: { id: created.id } });
      expect(record).toMatchObject({
        carrierContractRef: 'CTR-STC-002',
        bandwidthMbps: 40_000,
        slaLatencyMs: 12,
      });
      expect((await prisma.ci.findUniqueOrThrow({ where: { id: linkCi } })).attributes).toMatchObject({
        circuitCiIds: [loop.ci.id, backbone.ci.id],
        bandwidthMbps: 40_000,
      });

      // The backbone alone: the loop's edge is retired, the backbone's kept.
      const keptEdge = (await edges()).find((r) => r.toCiId === backbone.ci.id)?.id;
      await gql(SAVE, { linkId: linkCi, input: { ...input, circuitCiIds: [backbone.ci.id] } });
      const after = await edges();
      expect(after.map((r) => [r.id, r.toCiId])).toEqual([[keptEdge, backbone.ci.id]]);

      await expect(
        gql(SAVE, { linkId: linkCi, input: { ...input, circuitCiIds: [ryd.ciId] } }),
      ).rejects.toThrow(/not a current carrier circuit/);
      await expect(gql(SAVE, { linkId: loop.ci.id, input })).rejects.toThrow(/inter-site link .* not found/);

      // A backup on the same carrier and the same backbone is not diverse from the fibre.
      const backup = await setup.upsertSiteLink(actor, null, {
        fromSiteId: jed.id,
        toSiteId: ryd.id,
        kind: 'mpls',
        provider: 'STC',
        circuitId: 'MPLS-' + stamp,
        bandwidthMbps: 10_000,
        diversePaths: 1,
        role: 'backup',
        pathRef: 'South duct',
      });
      const backupCi = backup.ciId ?? '';
      await gql(SAVE, {
        linkId: backupCi,
        input: {
          kind: 'mpls',
          provider: 'STC',
          bandwidthMbps: 10_000,
          diversePaths: 1,
          role: 'backup',
          pathRef: 'South duct',
          circuitCiIds: [backbone.ci.id],
        },
      });
      const links = (await gql<{ connectivity: { links: LinkView[] } }>(CONNECTIVITY)).connectivity.links;
      const byId = new Map(links.map((l) => [l.ci.id, l]));
      expect(byId.get(backupCi)?.sharedRisks).toEqual([
        { kind: 'provider', value: 'stc', other: { id: linkCi } },
        { kind: 'circuit', value: backbone.ci.displayName, other: { id: linkCi } },
      ]);
      expect(byId.get(linkCi)?.sharedRisks.map((r) => [r.kind, r.other?.id])).toEqual([
        ['provider', backupCi],
        ['circuit', backupCi],
      ]);
      expect(byId.get(backupCi)?.carrierContractRef).toBeNull();

      // The reconciler writes the outbox to Memgraph; the backbone's outage then reaches both links upstream.
      const reached = await until(async () => {
        const impact = await graph.impact(tenantId, backbone.ci.id, {
          direction: 'upstream',
          maxDepth: 0,
          asOf: null,
          edgeTypes: [],
        });
        const ids = new Set(impact.nodes.map((n) => n.ci.id));
        return ids.has(linkCi) && ids.has(backupCi) ? ids : null;
      });
      expect(reached.has(loop.ci.id)).toBe(false);

      const audits = await prisma.outboxEvent.findMany({
        where: { tenantId, type: 'openmap.audit.action' },
        select: { envelope: true },
      });
      const actions = audits.map((a) => (a.envelope as { data: { action: string } }).data.action);
      expect(actions.filter((a) => a === 'connectivity.link_circuit.saved')).toHaveLength(3);
    },
    TIMEOUT_MS,
  );
});
