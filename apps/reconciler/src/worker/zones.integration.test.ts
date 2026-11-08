// T-512 REQ-IPAM-003 — a full zone transfer retires what the zone no longer holds (Postgres, through processResult):
// - a first transfer creates the zone and its records;
// - a second transfer without one record and with another's value changed retires the dropped record, the old value
//   and the relationships touching them (with openmap.ci.retired / openmap.relationship.retired events), and creates
//   the new value; the records still present are untouched;
// - a result that carries the zone without a complete transfer retires nothing.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import type { CollectorResult, ObservedCi, ObservedRelationship } from '@openmap/contracts';
import { createPrismaClient } from '@openmap/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processResult } from './pipeline.js';

const prisma = createPrismaClient();
const organizationId = randomUUID();
const tenantId = randomUUID();
const ZONE = 'itest-' + tenantId.slice(0, 8) + '.example';

function result(cis: ObservedCi[], relationships: ObservedRelationship[]): CollectorResult {
  const runId = randomUUID();
  const at = new Date().toISOString();
  return {
    jobId: runId, runId, tenantId, collectorId: 'dns', nodeId: 'node-itest', status: 'success', startedAt: at, finishedAt: at, cis, relationships, samples: [],
    evidence: [], errors: [], metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: cis.length, relationshipsEmitted: relationships.length, durationMs: 1 },
    contractVersion: CONTRACT_VERSIONS.collector,
  };
}

function zoneTransfer(records: Array<[string, string, string]>, transfer: string | null = 'axfr'): CollectorResult {
  const at = new Date().toISOString();
  const zone: ObservedCi = { type: 'dns_zone', identity: { name: ZONE }, name: ZONE, attributes: transfer === null ? { server: 'ns1:53' } : { transfer, server: 'ns1:53' }, tags: [], externalIds: [], observedAt: at };
  const recs: ObservedCi[] = records.map(([name, type, value]) => ({ type: 'dns_record', identity: { zoneRef: ZONE, name: name + '.' + ZONE, recordType: type, value }, name: name + ' ' + type, attributes: { zone: ZONE, recordType: type, value, ttl: 3600 }, tags: [], externalIds: [], observedAt: at }));
  const rels: ObservedRelationship[] = recs.map((r) => ({ type: 'contains', from: { type: 'dns_zone', identity: { name: ZONE } }, to: { type: 'dns_record', identity: r.identity }, attributes: {}, observedAt: at }));
  return result([zone, ...recs], rels);
}

async function currentRecords(): Promise<string[]> {
  const rows = await prisma.ci.findMany({ where: { tenantId, type: 'dns_record', validTo: null }, select: { identity: true } });
  return rows.map((r) => {
    const i = r.identity as Record<string, string>;
    return (i['name'] ?? '').replace('.' + ZONE, '') + ' ' + (i['recordType'] ?? '') + ' ' + (i['value'] ?? '');
  }).sort();
}

describe('zone transfers retire what the zone no longer holds (integration)', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Zones org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: true } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'zones', slug: 'zones-' + tenantId.slice(0, 8) } });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('creates, then retires the dropped record and the old value of a changed one', async () => {
    const first = await processResult(prisma, zoneTransfer([['www', 'A', '10.0.0.80'], ['api', 'CNAME', 'www.' + ZONE + '.'], ['mail', 'A', '10.0.0.25']]));
    expect(first.zoneRecordsRetired).toBe(0);
    expect(await currentRecords()).toEqual(['api CNAME www.' + ZONE + '.', 'mail A 10.0.0.25', 'www A 10.0.0.80']);

    const second = await processResult(prisma, zoneTransfer([['www', 'A', '10.0.0.81'], ['api', 'CNAME', 'www.' + ZONE + '.']]));
    expect(second.zoneRecordsRetired).toBe(2);
    expect(await currentRecords()).toEqual(['api CNAME www.' + ZONE + '.', 'www A 10.0.0.81']);
    const openRels = await prisma.relationship.count({ where: { tenantId, type: 'contains', validTo: null } });
    expect(openRels).toBe(2);
    const events = await prisma.outboxEvent.findMany({ where: { tenantId, type: { in: ['openmap.ci.retired', 'openmap.relationship.retired'] } }, select: { type: true } });
    expect(events.filter((e) => e.type === 'openmap.ci.retired')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'openmap.relationship.retired')).toHaveLength(2);
  });

  it('retires nothing when the zone comes without a complete transfer', async () => {
    const partial = await processResult(prisma, zoneTransfer([['www', 'A', '10.0.0.81']], null));
    expect(partial.zoneRecordsRetired).toBe(0);
    expect(await currentRecords()).toEqual(['api CNAME www.' + ZONE + '.', 'www A 10.0.0.81']);
  });
});
