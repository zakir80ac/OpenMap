// T-480 REQ-BSM-007 (ADR-025) — the readiness evaluation against the real Postgres and ClickHouse, in a tenant of its
// own: two sites (RYD primary and criticality 1, JED the DR site) joined by a replication circuit and a backup circuit,
// both probed. Probe samples written to ClickHouse metrics drive each round:
// 1. both reachable and fast: the links are healthy and nothing breaches;
// 2. the replication circuit unreachable: it goes down, and `diverse_paths` (RYD keeps one path) and
//    `replication_healthy` open findings with incidents (rooted at the site and the link), while `dr_reachable` holds
//    over the backup circuit;
// 3. reachable again: both findings clear and their incidents are resolved.
// The graph is a recording stand-in (setHealth); the API and console read the same findings.
import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { loadEnv } from '@openmap/config';
import { READINESS } from '@openmap/constants';
import { LINK_METRICS } from '@openmap/contracts';
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
const SECOND_MS = 1_000;
let clock = Date.now();
const graphHealth = new Map<string, Health>();

const graph = {
  setHealth: (_tenant: string, id: string, health: Health) => {
    graphHealth.set(id, health);
    return Promise.resolve();
  },
} as unknown as GraphRepository;

async function ci(type: 'site' | 'site_link', identity: Record<string, string>, name: string, attributes: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await prisma.ci.create({
    data: {
      id, tenantId, type, identity, identityKey: name, name, displayName: name, code: 'R-' + id.slice(0, 8).toUpperCase(),
      layer: type === 'site' ? 'dc' : 'network_security', lifecycle: 'managed', attributes: attributes as object, tags: [],
      sourceCollectorId: 'test', sourceNodeId: 'test', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

async function probe(linkId: string, reachable: boolean, latencyMs: number): Promise<void> {
  const ts = new Date(clock).toISOString().replace('T', ' ').replace('Z', '');
  const rows = [
    { tenant_id: tenantId, ci_id: linkId, metric: LINK_METRICS.reachable, ts, value: reachable ? 1 : 0, unit: 'bool', labels: {}, source_run_id: randomUUID() },
    { tenant_id: tenantId, ci_id: linkId, metric: LINK_METRICS.lossPercent, ts, value: reachable ? 0 : 100, unit: '%', labels: {}, source_run_id: randomUUID() },
    ...(reachable ? [{ tenant_id: tenantId, ci_id: linkId, metric: LINK_METRICS.latencyMs, ts, value: latencyMs, unit: 'ms', labels: {}, source_run_id: randomUUID() }] : []),
  ];
  await clickhouse.insert({ table: env.CLICKHOUSE_DB + '.metrics', values: rows, format: 'JSONEachRow' });
}

const readiness = createReadiness({
  prisma,
  graph,
  query: async (_name, sql, params) => (await clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' })).json(),
  database: env.CLICKHOUSE_DB,
  healthMap: (_tenant, ids) => Promise.resolve(new Map(ids.map((id) => [id, graphHealth.get(id) ?? 'unknown']))),
  probeIntervalMs: PROBE_MS,
  now: () => new Date(clock).toISOString(),
});

let ryd = '';
let jed = '';
let replication = '';
let backup = '';

describe('HA / DR readiness (integration)', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Readiness org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'readiness', slug: 'readiness-' + tenantId.slice(0, 8) } });
    ryd = await ci('site', { code: 'RYD' }, 'RYD', { drRole: 'primary', criticality: 1 });
    jed = await ci('site', { code: 'JED' }, 'JED', { drRole: 'dr', criticality: 2 });
    replication = await ci('site_link', { circuitId: 'DF-1', fromSiteRef: 'RYD', toSiteRef: 'JED' }, 'RYD-JED fibre', { replication: true, diversePaths: 1, probeTarget: '10.16.0.1:443', slaLatencyMs: 25 });
    backup = await ci('site_link', { circuitId: 'MPLS-1', fromSiteRef: 'RYD', toSiteRef: 'JED' }, 'RYD-JED MPLS', { diversePaths: 1, probeTarget: '10.16.0.2:443' });
  });

  afterAll(async () => {
    await clickhouse.command({ query: 'ALTER TABLE ' + env.CLICKHOUSE_DB + '.metrics DELETE WHERE tenant_id = {t:UUID}', query_params: { t: tenantId }, clickhouse_settings: { mutations_sync: '2' } });
    await clickhouse.command({ query: 'ALTER TABLE ' + env.CLICKHOUSE_DB + '.metrics_latest DELETE WHERE tenant_id = {t:UUID}', query_params: { t: tenantId }, clickhouse_settings: { mutations_sync: '2' } });
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await clickhouse.close();
    await prisma.$disconnect();
  });

  it('opens and clears findings and incidents as the probes change', async () => {
    // 1. Both circuits answer within their commitments.
    await probe(replication, true, 12);
    await probe(backup, true, 19);
    let report = await readiness.evaluateTenant(tenantId);
    expect(report).toMatchObject({ links: 2, opened: 0, cleared: 0 });
    expect(graphHealth.get(replication)).toBe('healthy');
    expect(graphHealth.get(backup)).toBe('healthy');

    // 2. The replication circuit stops answering.
    clock += PROBE_MS;
    await probe(replication, false, 0);
    await probe(backup, true, 19);
    report = await readiness.evaluateTenant(tenantId);
    expect(graphHealth.get(replication)).toBe('down');
    expect(report.opened).toBe(2);
    const open = await prisma.readinessFinding.findMany({ where: { tenantId, state: 'open' }, orderBy: { rule: 'asc' } });
    expect(open.map((f) => [f.rule, f.subjectCiId])).toEqual([
      ['diverse_paths', ryd],
      ['replication_healthy', replication],
    ]);
    const incidents = await prisma.incident.findMany({ where: { tenantId, source: READINESS.incidentSource }, orderBy: { severity: 'asc' } });
    expect(incidents).toHaveLength(2);
    expect(incidents.every((i) => i.state === 'open' && i.affectedServiceCiIds.length === 0)).toBe(true);
    expect(incidents.map((i) => i.rootCauseCiId).sort()).toEqual([ryd, replication].sort());
    expect(open.every((f) => f.incidentId !== null)).toBe(true);
    // The DR site is still reachable over the backup circuit; a second round opens nothing more.
    expect(open.some((f) => f.rule === 'dr_reachable' && f.subjectCiId === jed)).toBe(false);
    expect((await readiness.evaluateTenant(tenantId)).opened).toBe(0);

    // 3. The circuit is back.
    clock += PROBE_MS + SECOND_MS;
    await probe(replication, true, 13);
    await probe(backup, true, 19);
    report = await readiness.evaluateTenant(tenantId);
    expect(report.cleared).toBe(2);
    expect(graphHealth.get(replication)).toBe('healthy');
    expect(await prisma.readinessFinding.count({ where: { tenantId, state: 'open' } })).toBe(0);
    expect((await prisma.incident.findMany({ where: { tenantId, source: READINESS.incidentSource } })).every((i) => i.state === 'resolved' && i.resolvedAt !== null)).toBe(true);
  });
});
