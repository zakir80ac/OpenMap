// T-131 REQ-CMDB-039 — the register sync against the real Postgres (ADR-023): created owned CIs get one row each in
// one array statement, a tag already taken falls back to the CI code, non-owned CIs get none, a later update refreshes
// what discovery reports without touching a person's cover, and the rows are idempotent across a second persist.
// T-177 REQ-CMDB-020 (ADR-034): a new CI whose serial matches a received plan unit claims it (deployed, linked, audited,
// one stage event) instead of getting a second row; a unit still planned is not claimed.
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@openmap/db';
import type { Ci } from '@openmap/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimReceivedAssets, insertAssetsBatch, refreshAssetsBatch } from './assets.js';
import { claimEvents } from './persist.js';

const prisma = createPrismaClient();
const tenantId = randomUUID();
const organizationId = randomUUID();
const now = new Date().toISOString();

function ci(type: Ci['type'], layer: Ci['layer'], name: string, code: string, attributes: Record<string, unknown>): Ci {
  return {
    id: randomUUID(),
    tenantId,
    type,
    identity: { name },
    name,
    displayName: name,
    code,
    layer,
    lifecycle: 'managed',
    attributes,
    tags: [],
    source: { collectorId: 'test', nodeId: 'test', runId: 'test', confidence: 0.9 },
    observedAt: now,
    validFrom: now,
    validTo: null,
    checksum: 'b'.repeat(64),
  } as Ci;
}

async function storeCis(cis: readonly Ci[]): Promise<void> {
  await prisma.ci.createMany({
    data: cis.map((c) => ({
      id: c.id,
      tenantId,
      type: c.type,
      identity: c.identity,
      identityKey: c.name,
      name: c.name,
      displayName: c.displayName,
      code: c.code,
      layer: c.layer,
      lifecycle: c.lifecycle,
      attributes: c.attributes as object,
      tags: c.tags,
      sourceCollectorId: 'test',
      sourceNodeId: 'test',
      sourceRunId: 'test',
      sourceConfidence: 0.9,
      observedAt: new Date(now),
      validFrom: new Date(now),
      checksum: c.checksum,
    })),
  });
}

describe('asset register sync (integration)', () => {
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: organizationId, name: 'Asset sync org', industry: 'test', timeZone: 'UTC', defaultLocale: 'en', regulatoryScope: [], airGapped: false } });
    await prisma.tenant.create({ data: { id: tenantId, organizationId, name: 'asset-sync', slug: 'asset-sync-' + tenantId.slice(0, 8) } });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('creates one register row per owned CI, falls back on a taken tag, refreshes discovery fields and stays idempotent', async () => {
    const host = ci('host', 'hardware', 'esx-01', 'HW-ESX-01', { assetTag: 'SRV-0001', serialNumber: 'SN-1', manufacturer: 'Dell', model: 'PowerEdge R760', warrantyEnd: '2027-12-24', purchaseDate: '2024-12-24', currency: 'SAR' });
    const twin = ci('host', 'hardware', 'esx-02', 'HW-ESX-02', { assetTag: 'SRV-0001', manufacturer: 'Dell', model: 'PowerEdge R750' });
    const licence = ci('licence', 'applications', 'falcon', 'APP-FALCON', { vendor: 'CrowdStrike', software: 'Falcon Sensor', expiresAt: '2027-06-26', poNumber: 'PO-1', licenceType: 'perpetual' });
    const address = ci('ip_address', 'network_security', '10.0.0.1', 'NET-10-0-0-1', {});
    await storeCis([host, twin, licence, address]);

    const created = await prisma.$transaction((tx) => insertAssetsBatch(tx, [host, twin, licence, address]));
    expect(created).toBe(3);
    const rows = await prisma.assetRecord.findMany({ where: { tenantId }, orderBy: { assetTag: 'asc' } });
    expect(rows.map((r) => r.assetTag)).toEqual(['APP-FALCON', 'HW-ESX-02', 'SRV-0001']);
    const hostRow = rows.find((r) => r.ciId === host.id);
    expect(hostRow).toMatchObject({ ciType: 'host', layer: 'hardware', source: 'discovery', stage: 'deployed', serialNumber: 'SN-1', manufacturer: 'Dell', model: 'PowerEdge R760', residualValueCurrency: 'SAR' });
    expect(hostRow?.warranty).toMatchObject({ provider: 'Dell', endsAt: '2027-12-24', startsAt: '2024-12-24', source: 'vendor_api' });
    expect(hostRow?.purchasedAt?.toISOString().slice(0, 'YYYY-MM-DD'.length)).toBe('2024-12-24');
    const licenceRow = rows.find((r) => r.ciId === licence.id);
    expect(licenceRow?.support).toMatchObject({ provider: 'CrowdStrike', contractNumber: 'PO-1', endsAt: '2027-06-26', source: 'vendor_api' });
    expect(licenceRow?.manufacturer).toBe('CrowdStrike');
    expect(rows.find((r) => r.ciId === address.id)).toBeUndefined();

    // A person records the warranty by hand; the next sweep reports a new serial and a vendor warranty.
    await prisma.assetRecord.update({ where: { id: hostRow?.id ?? '' }, data: { warranty: { provider: 'Dell ProSupport', level: 'Plus', startsAt: null, endsAt: '2029-01-01', source: 'manual', verifiedAt: now } } });
    const refreshed = { ...host, attributes: { ...host.attributes, serialNumber: 'SN-1-REPLACED', warrantyEnd: '2028-01-01' } };
    await prisma.$transaction((tx) => refreshAssetsBatch(tx, [refreshed]));
    const after = await prisma.assetRecord.findFirst({ where: { tenantId, ciId: host.id } });
    expect(after?.serialNumber).toBe('SN-1-REPLACED');
    expect(after?.warranty).toMatchObject({ source: 'manual', endsAt: '2029-01-01' });

    // Persisting the same CIs again adds nothing.
    const again = await prisma.$transaction((tx) => insertAssetsBatch(tx, [host, twin, licence]));
    expect(again).toBe(3);
    expect(await prisma.assetRecord.count({ where: { tenantId } })).toBe(3);
  });

  it('lets a discovered CI claim the received plan unit with its serial instead of a new row (REQ-CMDB-020)', async () => {
    const plan = await prisma.infraPlan.create({
      data: { tenantId, number: 'PLAN-RCV', name: 'Receiving', description: 'claim test', kind: 'stack_expansion', status: 'building', owner: 'test', targetRackCiIds: [], externalRefs: [] },
    });
    const line = await prisma.bomLine.create({
      data: { tenantId, planId: plan.id, position: 0, description: 'Edge host', layer: 'hardware', quantity: 2, received: 1 },
    });
    const unit = (tag: string, stage: 'planned' | 'in_stock', serialNumber: string): Parameters<typeof prisma.assetRecord.create>[0]['data'] => ({
      tenantId,
      planId: plan.id,
      bomLineId: line.id,
      layer: 'dc',
      source: 'plan',
      assetTag: tag,
      serialNumber,
      model: 'R660',
      stage,
      stageChangedAt: new Date(now),
      purchaseCostAmount: 38_000,
      purchaseCostCurrency: 'SAR',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      residualValueAmount: 0,
      residualValueCurrency: 'SAR',
      tags: [],
      customFields: {},
    });
    const received = await prisma.assetRecord.create({ data: unit('PLAN-RCV-1-1', 'in_stock', 'SN-RCV-1') });
    await prisma.assetRecord.create({ data: unit('PLAN-RCV-1-2', 'planned', 'SN-RCV-2') });

    const racked = ci('host', 'hardware', 'edge-01', 'HW-EDGE-01', { serialNumber: 'SN-RCV-1', assetTag: 'SRV-EDGE-01', manufacturer: 'Dell', model: 'PowerEdge R660' });
    const early = ci('host', 'hardware', 'edge-02', 'HW-EDGE-02', { serialNumber: 'SN-RCV-2', manufacturer: 'Dell' });
    await storeCis([racked, early]);
    const claimed = await prisma.$transaction(async (tx) => {
      const c = await claimReceivedAssets(tx, [racked, early]);
      await insertAssetsBatch(tx, [racked, early]);
      return c;
    });

    expect(claimed).toEqual([
      { assetId: received.id, tenantId, ciId: racked.id, planId: plan.id, assetTag: 'PLAN-RCV-1-1', serialNumber: 'SN-RCV-1', actor: 'discovery:test' },
    ]);
    const claimedRow = await prisma.assetRecord.findUniqueOrThrow({ where: { id: received.id } });
    expect(claimedRow).toMatchObject({ ciId: racked.id, ciType: 'host', layer: 'hardware', stage: 'deployed', source: 'plan', assetTag: 'PLAN-RCV-1-1', planId: plan.id, bomLineId: line.id, depreciationMethod: 'straight_line' });
    expect(await prisma.assetRecord.count({ where: { tenantId, ciId: racked.id } })).toBe(1);
    // The unit still planned is not claimed: its CI gets a discovery row of its own.
    expect(await prisma.assetRecord.findFirst({ where: { tenantId, ciId: early.id }, select: { source: true } })).toEqual({ source: 'discovery' });
    const audits = await prisma.assetAudit.findMany({ where: { assetId: received.id }, orderBy: { field: 'asc' } });
    expect(audits.map((a) => [a.field, a.fromValue, a.toValue, a.actor])).toEqual([
      ['ciId', null, racked.id, 'discovery:test'],
      ['stage', 'in_stock', 'deployed', 'discovery:test'],
    ]);
    const [event] = claimEvents(claimed);
    expect(event).toMatchObject({ type: 'openmap.asset.stage.changed', subject: received.id, tenantid: tenantId, data: { stage: 'deployed', previous: 'in_stock', ciId: racked.id } });

    // A second sweep of the same CIs claims nothing more.
    expect(await prisma.$transaction((tx) => claimReceivedAssets(tx, [racked]))).toEqual([]);
  });
});
