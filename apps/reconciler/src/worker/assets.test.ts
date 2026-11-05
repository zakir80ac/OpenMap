// T-127 REQ-CMDB-039 — the register row a CI deserves (ADR-023): owned types only, the organisation's own tag before
// the CI code, make/model/serial and vendor-API warranty from the attributes the collectors observed, a licence's
// expiry as subscription cover, and nothing invented for what the attributes lack.
import { OWNED_CI_TYPES, type Ci } from '@openmap/contracts';
import { describe, expect, it } from 'vitest';
import { assetRowFor, assetRowsFor } from './assets.js';

function ci(type: Ci['type'], attributes: Record<string, unknown>, code = 'HW-TEST'): Ci {
  return {
    id: '0f6f4f1e-0d4e-4c7a-9f0e-000000000001',
    tenantId: '0f6f4f1e-0d4e-4c7a-9f0e-000000000002',
    type,
    identity: { serialNumber: 'SN1' },
    name: 'esx-01',
    displayName: 'esx-01.bank.local',
    code,
    layer: 'hardware',
    lifecycle: 'managed',
    attributes,
    tags: [],
    source: { collectorId: 'vmware', nodeId: 'node-1', runId: 'run-1', confidence: 0.9 },
    observedAt: '2026-11-05T00:00:00.000Z',
    validFrom: '2026-11-05T00:00:00.000Z',
    validTo: null,
    checksum: 'a'.repeat(64),
  } as Ci;
}

describe('asset rows from CIs', () => {
  it('maps a discovered host with its own tag, serial, make, model and vendor warranty', () => {
    const row = assetRowFor(ci('host', { assetTag: 'SRV-XFTBS6G', serialNumber: 'ABC123', manufacturer: 'Dell', model: 'PowerEdge R760', partNumber: '0R760', purchaseDate: '2024-12-24', warrantyEnd: '2027-12-24', warrantyProvider: 'Dell ProSupport', warrantyLevel: 'ProSupport Plus', currency: 'SAR' }));
    expect(row).not.toBeNull();
    expect(row?.assetTag).toBe('SRV-XFTBS6G');
    expect(row?.serialNumber).toBe('ABC123');
    expect(row?.manufacturer).toBe('Dell');
    expect(row?.model).toBe('PowerEdge R760');
    expect(row?.partNumber).toBe('0R760');
    expect(row?.purchasedAt).toBe('2024-12-24');
    expect(row?.currency).toBe('SAR');
    expect(JSON.parse(row?.warranty ?? 'null')).toEqual({ provider: 'Dell ProSupport', level: 'ProSupport Plus', startsAt: '2024-12-24', endsAt: '2027-12-24', source: 'vendor_api', verifiedAt: null });
    expect(row?.support).toBeNull();
  });

  it('falls back to the CI code for the tag and leaves unknown fields null rather than inventing them', () => {
    const row = assetRowFor(ci('software_instance', { name: 'Enterprise Linux Server Subscription', vendor: 'Red Hat', version: '9' }, 'APP-RHEL-SUB'));
    expect(row?.assetTag).toBe('APP-RHEL-SUB');
    expect(row?.manufacturer).toBe('Red Hat');
    expect(row?.model).toBe('Enterprise Linux Server Subscription');
    expect(row?.serialNumber).toBeNull();
    expect(row?.warranty).toBeNull();
    expect(row?.purchasedAt).toBeNull();
    expect(row?.currency).toBe('XXX');
  });

  it('records a licence expiry as subscription support cover', () => {
    const row = assetRowFor(ci('licence', { vendor: 'CrowdStrike', software: 'Falcon Sensor', expiresAt: '2027-06-26', poNumber: 'PO-1', licenceType: 'perpetual' }));
    expect(JSON.parse(row?.support ?? 'null')).toEqual({ provider: 'CrowdStrike', contractNumber: 'PO-1', level: 'perpetual', endsAt: '2027-06-26', source: 'vendor_api', verifiedAt: null });
  });

  it('ignores a warranty end that is not a calendar date and a warranty without a provider', () => {
    expect(assetRowFor(ci('host', { warrantyEnd: 'next year', manufacturer: 'Dell' }))?.warranty).toBeNull();
    expect(assetRowFor(ci('host', { warrantyEnd: '2027-01-01' }))?.warranty).toBeNull();
  });

  it('skips CIs whose type is not owned and keeps every owned type', () => {
    expect(assetRowFor(ci('ip_address', {}))).toBeNull();
    expect(assetRowFor(ci('interface', {}))).toBeNull();
    expect(assetRowFor(ci('site', {}))).toBeNull();
    expect(assetRowFor(ci('unknown', {}))).toBeNull();
    const rows = assetRowsFor(OWNED_CI_TYPES.map((type) => ci(type, {})));
    expect(rows).toHaveLength(OWNED_CI_TYPES.length);
  });
});
