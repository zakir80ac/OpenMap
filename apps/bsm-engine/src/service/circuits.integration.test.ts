// T-591 REQ-IPAM-007 (ADR-069) — network circuits in the readiness evaluation, against the real Postgres and
// ClickHouse in a tenant of its own. RYD and JED are joined by a primary fibre and a backup MPLS link; neither is
// probed, each rides a carrier circuit (depends_on), and the fibre's circuit hands off on a router interface at RYD.
// 1. everything up: both links take `healthy` from their circuits; the MPLS link has the same provider as the fibre,
//    so `path_diversity` opens a low-severity finding on it (the backup, not the primary);
// 2. the hand-off interface goes down: the fibre's circuit is down, so the fibre is down, and `redundancy_lost` opens
//    an incident on it that names the business service the impact graph reaches from the link;
// 3. the interface is back and the MPLS link moves to another carrier: both findings clear and their incidents resolve.
// The graph is a recording stand-in (health, and an impact walk from the fibre that reaches the service).
import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { loadEnv } from '@openmap/config';
import { READINESS } from '@openmap/constants';
import { LINK_CIRCUIT_RELATIONSHIP, type RelationshipType } from '@openmap/contracts';
import { clickhouseOptions, createPrismaClient } from '@openmap/db';
import type { GraphRepository } from '@openmap/graph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Health } from '../core/propagate.js';
import { createReadiness } from './readiness.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const clickhouse = createClient(clickhouseOptions(env));
const tenantId = randomUUID();
const organizationId = randomUUID();
const PROBE_MS = 60_000;
let clock = Date.now();
const graphHealth = new Map<string, Health>();
const service = randomUUID();
let fibre = '';
let mpls = '';
let fibreCircuit = '';
let mplsCircuit = '';
let handOff = '';

const graph = {
  setHealth: (_tenant: string, id: string, health: Health) => {
    graphHealth.set(id, health);
    return Promise.resolve();
  },
  impact: (_tenant: string, rootId: string) =>
    Promise.resolve({
      rootId,
      nodes: [],
      services:
        rootId === fibre
          ? [
              {
                ci: { id: service, tenantId, type: 'business_service', tier: 1 },
                depth: 2,
                path: [rootId, service],
              },
            ]
          : [],
      durationMs: 0,
    }),
} as unknown as GraphRepository;

type TestType = 'site' | 'site_link' | 'circuit' | 'interface';
const LAYER: Record<TestType, string> = {
  site: 'dc',
  site_link: 'network_security',
  circuit: 'network_security',
  interface: 'network_security',
};

async function ci(
  type: TestType,
  identity: Record<string, string>,
  name: string,
  attributes: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await prisma.ci.create({
    data: {
      id,
      tenantId,
      type,
      identity,
      identityKey: name,
      name,
      displayName: name,
      code: 'R-' + id.slice(0, 8).toUpperCase(),
      layer: LAYER[type] as never,
      lifecycle: 'managed',
      attributes: attributes as object,
      tags: [],
      sourceCollectorId: 'test',
      sourceNodeId: 'test',
      sourceRunId: randomUUID(),
      sourceConfidence: 1,
      observedAt: now,
      validFrom: now,
      checksum: 'c'.repeat(64),
    },
  });
  return id;
}

async function relate(
  type: RelationshipType,
  fromCiId: string,
  toCiId: string,
  attributes: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date();
  await prisma.relationship.create({
    data: {
      tenantId,
      type,
      fromCiId,
      toCiId,
      attributes: attributes as object,
      sourceCollectorId: 'test',
      sourceNodeId: 'test',
      sourceRunId: randomUUID(),
      sourceConfidence: 1,
      observedAt: now,
      validFrom: now,
    },
  });
}

const readiness = createReadiness({
  prisma,
  graph,
  query: async (_name, sql, params) =>
    (await clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' })).json(),
  database: env.CLICKHOUSE_DB,
  healthMap: (_tenant, ids) =>
    Promise.resolve(new Map(ids.map((id) => [id, graphHealth.get(id) ?? 'unknown']))),
  probeIntervalMs: PROBE_MS,
  now: () => new Date(clock).toISOString(),
});

describe('network circuits in readiness (integration)', () => {
  beforeAll(async () => {
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Circuits org',
        industry: 'test',
        timeZone: 'UTC',
        defaultLocale: 'en',
        regulatoryScope: [],
        airGapped: false,
      },
    });
    await prisma.tenant.create({
      data: { id: tenantId, organizationId, name: 'circuits', slug: 'circuits-' + tenantId.slice(0, 8) },
    });
    await ci('site', { code: 'RYD' }, 'RYD', {});
    await ci('site', { code: 'JED' }, 'JED', {});
    fibreCircuit = await ci('circuit', { circuitId: 'DF-100', provider: 'stc' }, 'stc DF-100', {
      kind: 'dark_fibre',
      status: 'active',
    });
    mplsCircuit = await ci('circuit', { circuitId: 'MP-200', provider: 'stc' }, 'stc MP-200', {
      kind: 'mpls',
      status: 'active',
    });
    handOff = await ci('interface', { device: 'ryd-wan-1', name: 'xe-0/0/1' }, 'ryd-wan-1 xe-0/0/1', {
      operStatus: 'up',
    });
    fibre = await ci(
      'site_link',
      { circuitId: 'DF-100', fromSiteRef: 'RYD', toSiteRef: 'JED' },
      'RYD-JED fibre',
      { role: 'primary', provider: 'stc', diversePaths: 1, pathRef: 'north duct' },
    );
    mpls = await ci(
      'site_link',
      { circuitId: 'MP-200', fromSiteRef: 'RYD', toSiteRef: 'JED' },
      'RYD-JED MPLS',
      { role: 'backup', provider: 'STC', diversePaths: 1, pathRef: 'south duct' },
    );
    await relate(LINK_CIRCUIT_RELATIONSHIP, fibre, fibreCircuit);
    await relate(LINK_CIRCUIT_RELATIONSHIP, mpls, mplsCircuit);
    await relate('connected_to', fibreCircuit, handOff, { end: 'A', port: 'xe-0/0/1', side: null });
    for (const id of [fibreCircuit, mplsCircuit, handOff]) graphHealth.set(id, 'healthy');
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await clickhouse.close();
    await prisma.$disconnect();
  });

  it('takes link health from carrier circuits and raises shared risks and lost redundancy', async () => {
    // 1. Everything up; the backup shares the primary's carrier.
    let report = await readiness.evaluateTenant(tenantId);
    expect(graphHealth.get(fibre)).toBe('healthy');
    expect(graphHealth.get(mpls)).toBe('healthy');
    expect(report).toMatchObject({ links: 2, opened: 1, openedByRule: { path_diversity: 1 } });
    let open = await prisma.readinessFinding.findMany({ where: { tenantId, state: 'open' } });
    expect(open.map((f) => [f.rule, f.subjectCiId])).toEqual([['path_diversity', mpls]]);
    expect(open[0]?.detail).toBe(
      'RYD-JED MPLS shares provider stc with RYD-JED fibre: they are not diverse paths.',
    );
    const diversity = await prisma.incident.findUniqueOrThrow({ where: { id: open[0]?.incidentId ?? '' } });
    expect(diversity).toMatchObject({
      severity: READINESS.severity.path_diversity,
      rootCauseCiId: mpls,
      affectedServiceCiIds: [],
    });

    // 2. The fibre's hand-off port goes down at RYD.
    clock += PROBE_MS;
    graphHealth.set(handOff, 'down');
    report = await readiness.evaluateTenant(tenantId);
    expect(graphHealth.get(fibre)).toBe('down');
    expect(graphHealth.get(mpls)).toBe('healthy');
    expect(report.linkHealthChanged).toBe(1);
    expect(report.openedByRule).toEqual({ redundancy_lost: 1 });
    const lost = await prisma.readinessFinding.findFirstOrThrow({
      where: { tenantId, state: 'open', rule: 'redundancy_lost' },
    });
    expect(lost.subjectCiId).toBe(fibre);
    expect(lost.detail).toBe('RYD-JED fibre is down; RYD-JED has 1 of 2 paths up.');
    const outage = await prisma.incident.findUniqueOrThrow({ where: { id: lost.incidentId ?? '' } });
    expect(outage).toMatchObject({
      severity: READINESS.severity.redundancy_lost,
      rootCauseCiId: fibre,
      affectedServiceCiIds: [service],
      state: 'open',
    });
    expect((await readiness.evaluateTenant(tenantId)).opened).toBe(0);

    // 3. The port is back, and the backup moves to another carrier.
    clock += PROBE_MS;
    graphHealth.set(handOff, 'healthy');
    const link = await prisma.ci.findUniqueOrThrow({ where: { id: mpls } });
    await prisma.ci.update({
      where: { id: mpls },
      data: { attributes: { ...(link.attributes as object), provider: 'Mobily' } },
    });
    report = await readiness.evaluateTenant(tenantId);
    expect(graphHealth.get(fibre)).toBe('healthy');
    expect(report.clearedByRule).toEqual({ path_diversity: 1, redundancy_lost: 1 });
    open = await prisma.readinessFinding.findMany({ where: { tenantId, state: 'open' } });
    expect(open).toHaveLength(0);
    const incidents = await prisma.incident.findMany({
      where: { tenantId, source: READINESS.incidentSource },
    });
    expect(incidents).toHaveLength(2);
    expect(incidents.every((i) => i.state === 'resolved')).toBe(true);
  });
});
