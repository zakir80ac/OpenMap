// T-534 REQ-DCIM-005 (ADR-059) — power threshold alerting against the compose stack, in a tenant of its own:
// - a PDU (16 A × 230 V = 3,680 W) drawing 3.5 kW is over the default critical line (90%): one incident opens (source
//   power, the PDU as root cause), and the next evaluation opens no second one;
// - a PDU over the line whose latest reading is older than POWER.alertFreshMs is not judged;
// - when the first PDU's newest reading falls to 2 kW, its incident is resolved; both changes reach the outbox.
import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { loadEnv } from '@openmap/config';
import { POWER } from '@openmap/constants';
import { POWER_METRICS } from '@openmap/contracts';
import { clickhouseOptions, createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPowerAlerts } from './power.js';

const env = loadEnv();
const prisma = createPrismaClient(env);
const clickhouse = createClient(clickhouseOptions(env));
const tenantId = randomUUID();
const organizationId = randomUUID();
const MINUTE_MS = 60_000;
let clock = Date.now();

async function pdu(name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await prisma.ci.create({
    data: {
      id, tenantId, type: 'pdu', identity: { serialNumber: 'PWA-' + id.slice(0, 8) }, identityKey: 'PWA-' + id.slice(0, 8), name, displayName: name, code: 'PWA-' + id.slice(0, 6).toUpperCase(),
      layer: 'dc', lifecycle: 'discovered', attributes: { ratedAmps: 16, inputVoltage: 230, feed: 'A' }, tags: [],
      sourceCollectorId: 'test', sourceNodeId: 'test', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

async function reading(ciId: string, atMs: number, watts: number): Promise<void> {
  const ts = new Date(atMs).toISOString().replace('T', ' ').replace('Z', '');
  await clickhouse.insert({ table: env.CLICKHOUSE_DB + '.metrics', values: [{ tenant_id: tenantId, ci_id: ciId, metric: POWER_METRICS.pdu, ts, value: watts, unit: 'W', labels: {}, source_run_id: randomUUID() }], format: 'JSONEachRow' });
}

const alerts = createPowerAlerts({
  prisma,
  query: async (_name, sql, params) => (await clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' })).json(),
  database: env.CLICKHOUSE_DB,
  now: () => new Date(clock).toISOString(),
});

describe('power threshold alerting (integration)', () => {
  let hot = '';
  let stale = '';

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Power alert org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'power alerts', slug: 'power-alerts-' + tenantId.slice(0, 8) } });
    hot = await pdu('PWA-R01 PDU-A');
    stale = await pdu('PWA-R02 PDU-A');
    await reading(hot, clock - MINUTE_MS, 3_500);
    await reading(stale, clock - POWER.alertFreshMs - MINUTE_MS, 3_600);
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await clickhouse.close();
    await prisma.$disconnect();
  });

  it('opens one incident for a PDU over the critical line and resolves it when the draw falls back', async () => {
    const first = await alerts.evaluateTenant(tenantId);
    expect(first).toEqual({ pdus: 2, judged: 1, opened: 1, resolved: 0 });
    const incidents = await prisma.incident.findMany({ where: { tenantId, source: POWER.incidentSource } });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ rootCauseCiId: hot, state: 'open', severity: POWER.incidentSeverity });
    expect(incidents[0]?.title).toContain('3500 W of its 3680 W rating');

    expect(await alerts.evaluateTenant(tenantId)).toMatchObject({ opened: 0, resolved: 0 });

    clock += MINUTE_MS;
    await reading(hot, clock, 2_000);
    expect(await alerts.evaluateTenant(tenantId)).toMatchObject({ opened: 0, resolved: 1 });
    const resolved = await prisma.incident.findFirst({ where: { tenantId, rootCauseCiId: hot } });
    expect(resolved?.state).toBe('resolved');
    const events = await prisma.outboxEvent.findMany({ where: { tenantId }, select: { type: true } });
    expect(events.map((e) => e.type).sort()).toEqual(['openmap.incident.opened', 'openmap.incident.resolved']);
  });
});
