// T-540 REQ-DCIM-006 (ADR-060) — environmental alerting against the compose stack, in a tenant of its own:
// - a rack whose inlet probe (on its PDU) reads 34 °C, outside the allowable range: one incident opens (source
//   environment, the rack as root cause), and the next evaluation opens no second one;
// - a rack at 29 °C (outside the recommended range, inside the allowable one) opens nothing;
// - when the hot rack's inlet reads 24 °C, its incident is resolved.
import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { loadEnv } from '@openmap/config';
import { ENVIRONMENT } from '@openmap/constants';
import { ENV_METRICS } from '@openmap/contracts';
import { clickhouseOptions, createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnvironmentAlerts } from './environment.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const clickhouse = createClient(clickhouseOptions(env));
const tenantId = randomUUID();
const organizationId = randomUUID();
const MINUTE_MS = 60_000;
let clock = Date.now();

async function ci(type: 'rack' | 'pdu', name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await prisma.ci.create({
    data: {
      id, tenantId, type, identity: { serialNumber: 'ENA-' + id.slice(0, 8) }, identityKey: 'ENA-' + id.slice(0, 8), name, displayName: name, code: 'ENA-' + id.slice(0, 6).toUpperCase(),
      layer: 'dc', lifecycle: 'discovered', attributes: {}, tags: [], sourceCollectorId: 'test', sourceNodeId: 'test', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

async function inlet(ciId: string, atMs: number, c: number): Promise<void> {
  const ts = new Date(atMs).toISOString().replace('T', ' ').replace('Z', '');
  await clickhouse.insert({ table: env.CLICKHOUSE_DB + '.metrics', values: [{ tenant_id: tenantId, ci_id: ciId, metric: ENV_METRICS.temperature, ts, value: c, unit: 'C', labels: { position: 'inlet' }, source_run_id: randomUUID() }], format: 'JSONEachRow' });
}

const alerts = createEnvironmentAlerts({
  prisma,
  query: async (_name, sql, params) => (await clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' })).json(),
  database: env.CLICKHOUSE_DB,
  now: () => new Date(clock).toISOString(),
});

describe('environmental alerting (integration)', () => {
  let hot = '';

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Environment alert org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'environment alerts', slug: 'env-alerts-' + tenantId.slice(0, 8) } });
    hot = await ci('rack', 'ENA-R01');
    const warm = await ci('rack', 'ENA-R02');
    const probe = await ci('pdu', 'ENA-R01 PDU-A');
    const now = new Date();
    await prisma.relationship.create({ data: { id: randomUUID(), tenantId, type: 'located_in', fromCiId: probe, toCiId: hot, attributes: {}, sourceCollectorId: 'test', sourceNodeId: 'test', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now } });
    await inlet(probe, clock - MINUTE_MS, ENVIRONMENT.allowableC.max + 2);
    await inlet(warm, clock - MINUTE_MS, ENVIRONMENT.recommendedC.max + 2);
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await clickhouse.close();
    await prisma.$disconnect();
  });

  it('opens one incident for a rack outside the allowable range and resolves it when it cools', async () => {
    expect(await alerts.evaluateTenant(tenantId)).toEqual({ racks: 2, judged: 2, opened: 1, resolved: 0 });
    const incidents = await prisma.incident.findMany({ where: { tenantId, source: ENVIRONMENT.incidentSource } });
    expect(incidents.map((i) => i.rootCauseCiId)).toEqual([hot]);
    expect(await alerts.evaluateTenant(tenantId)).toMatchObject({ opened: 0, resolved: 0 });

    clock += MINUTE_MS;
    const probe = await prisma.relationship.findFirst({ where: { tenantId, toCiId: hot }, select: { fromCiId: true } });
    await inlet(probe?.fromCiId ?? '', clock, 24);
    expect(await alerts.evaluateTenant(tenantId)).toMatchObject({ opened: 0, resolved: 1 });
    expect((await prisma.incident.findFirst({ where: { tenantId, rootCauseCiId: hot } }))?.state).toBe('resolved');
  });
});
