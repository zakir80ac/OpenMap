// T-508 REQ-AI-005 (ADR-054) — cloud recommendations against the compose stack, in a tenant of their own:
// - a stopped database still billed is released, an idle VM decommissioned, an under-used VM downsized at half its
//   cost, a hot VM upsized; a VM used about right and a network resource get nothing;
// - load comes from the lookback window when it holds samples (average and peak over them), else from the latest
//   sample; the total saving adds up the items; and on the estate tenants every advised resource names a cloud CI.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { CLOUD_ADVICE, TIME } from '@openmap/constants';
import { loadEnv } from '@openmap/config';
import { createPrismaClient } from '@openmap/db';
import { AppModule } from '../app.module.js';
import { ClickHouseService } from '../db/clickhouse.service.js';
import { CloudAdviceService } from './cloud-advice.service.js';

process.env['IMPACT_VALIDATION_INTERVAL_MS'] = '0';
process.env['ANOMALY_INTERVAL_MS'] = '0';
const env = loadEnv();
const prisma = createPrismaClient(env);
const TIMEOUT_MS = 120_000;
const organizationId = randomUUID();
const tenantId = randomUUID();
let app: NestFastifyApplication;

async function resource(name: string, attributes: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await prisma.ci.create({
    data: {
      id, tenantId, type: 'cloud_resource', identity: { provider: 'aws', resourceId: name + '-' + id.slice(0, 6) }, identityKey: name + id, name, displayName: name, code: 'CLD-' + id.slice(0, 6).toUpperCase(),
      layer: 'cloud', lifecycle: 'discovered', attributes: attributes as object, tags: [], sourceCollectorId: 'itest', sourceNodeId: 'itest', sourceRunId: randomUUID(), sourceConfidence: 1, observedAt: now, validFrom: now, checksum: 'c'.repeat(64),
    },
  });
  return id;
}

const clickhouseTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

describe('cloud recommendations (integration)', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ['error', 'warn'] });
    await app.init();
    await prisma.organization.create({ data: { id: organizationId, name: 'Cloud advice org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'Cloud advice BU', slug: 'cloud-' + tenantId.slice(0, 8) } });
    const vm = (state: string, cost: number) => ({ resourceType: 'AWS::EC2::Instance', state, monthlyCostUsd: cost, sku: 'm6i.xlarge', tagOwner: 'payments', tagEnvironment: 'prod' });
    ids['stopped'] = await resource('db-stopped', { ...vm('stopped', 352.51), resourceType: 'AWS::RDS::DBInstance' });
    ids['idle'] = await resource('vm-idle', vm('running', 1200));
    ids['small'] = await resource('vm-small', vm('running', 800));
    ids['hot'] = await resource('vm-hot', vm('running', 600));
    ids['fine'] = await resource('vm-fine', vm('running', 500));
    ids['vpc'] = await resource('vpc-main', { resourceType: 'AWS::EC2::VPC', state: 'running', monthlyCostUsd: 40 });
    const now = Date.now();
    const window = (id: string, values: number[]) => values.map((value, i) => ({ tenant_id: tenantId, ci_id: id, metric: 'cloud.resource.load_percent', ts: clickhouseTime(now - (i + 1) * TIME.msPerHour), value, unit: 'percent', labels: {}, source_run_id: randomUUID() }));
    const ch = app.get(ClickHouseService);
    await ch.insert('metrics', [...window(ids['idle'] ?? '', [1, 2, 3]), ...window(ids['small'] ?? '', [14, 22, 30]), ...window(ids['hot'] ?? '', [88, 93]), ...window(ids['fine'] ?? '', [40, 65, 72])]);
    // Only a sample older than the window for the VPC: the latest-sample fallback still finds it.
    await ch.insert('metrics', [{ tenant_id: tenantId, ci_id: ids['vpc'], metric: 'cloud.resource.load_percent', ts: clickhouseTime(now - (CLOUD_ADVICE.lookbackDays + 1) * TIME.msPerDay), value: 1, unit: 'percent', labels: {}, source_run_id: randomUUID() }]);
  }, TIMEOUT_MS);

  afterAll(async () => {
    const ch = app.get(ClickHouseService);
    await ch.query('cloud_itest_cleanup', 'ALTER TABLE ' + env.CLICKHOUSE_DB + '.metrics DELETE WHERE tenant_id = {tenantId:UUID}', { tenantId });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it('advises each resource from its state, cost and load', async () => {
    const advice = await app.get(CloudAdviceService).advise(tenantId);
    const kinds = Object.fromEntries(advice.items.map((i) => [i.ciId, i.kind]));
    expect(kinds).toEqual({ [ids['stopped'] ?? '']: 'release_stopped', [ids['idle'] ?? '']: 'decommission_idle', [ids['small'] ?? '']: 'downsize', [ids['hot'] ?? '']: 'upsize' });
    const small = advice.items.find((i) => i.ciId === ids['small']);
    expect(small).toMatchObject({ savingUsd: 800 * CLOUD_ADVICE.rightsizeSavingShare, samples: 3, peakLoad: 30, sku: 'm6i.xlarge', owner: 'payments' });
    expect(small?.averageLoad).toBeCloseTo(22, 5);
    expect(advice.items.map((i) => i.ciId).slice(0, 2)).toEqual([ids['idle'], ids['small']]);
    expect(advice).toMatchObject({ resources: 6, monthlySavingUsd: 352.51 + 1200 + 400 });
  }, TIMEOUT_MS);

  it('advises on the estate tenants only for their cloud resources', async () => {
    const tenants = await prisma.ci.groupBy({ by: ['tenantId'], where: { type: 'cloud_resource', validTo: null }, _count: { _all: true }, orderBy: { _count: { tenantId: 'desc' } }, take: 1 });
    const estate = tenants[0]?.tenantId ?? '';
    const advice = await app.get(CloudAdviceService).advise(estate);
    expect(advice.resources).toBeGreaterThan(0);
    const cis = await prisma.ci.findMany({ where: { id: { in: advice.items.map((i) => i.ciId) } }, select: { type: true } });
    expect(cis.every((c) => c.type === 'cloud_resource')).toBe(true);
    console.log(JSON.stringify({ msg: 'cloud advice', tenant: estate, resources: advice.resources, items: advice.items.length, byKind: advice.items.reduce<Record<string, number>>((n, i) => ({ ...n, [i.kind]: (n[i.kind] ?? 0) + 1 }), {}), monthlySavingUsd: advice.monthlySavingUsd }));
  }, TIMEOUT_MS);
});
