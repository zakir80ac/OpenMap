// T-353 REQ-CMDB-024 — a vendor lookup's dates on a hardware CI become the asset's warranty (start, end, level,
// verification instant) and end of life (sale, software maintenance, support, source); CIs without them get none.
import { describe, expect, it } from 'vitest';
import { assetFieldsFromCi, endOfLifeFromAttributes } from './asset.js';

describe('vendor warranty and end-of-life attributes', () => {
  it('maps a warranty lookup onto the asset warranty', () => {
    const fields = assetFieldsFromCi('host', {
      manufacturer: 'Dell Inc.',
      serialNumber: 'ABC1234',
      warrantyProvider: 'Dell',
      warrantyLevel: 'ProSupport Plus Next Business Day',
      warrantyStart: '2024-01-02',
      warrantyEnd: '2029-01-01',
      warrantyVerifiedAt: '2026-11-07T08:00:00Z',
      purchaseDate: '2023-12-20',
    });
    expect(fields.warranty).toEqual({
      provider: 'Dell',
      level: 'ProSupport Plus Next Business Day',
      startsAt: '2024-01-02',
      endsAt: '2029-01-01',
      source: 'vendor_api',
      verifiedAt: '2026-11-07T08:00:00.000Z',
    });
    expect(fields.endOfLife).toBeNull();
  });

  it('falls back to the purchase date for the warranty start', () => {
    const fields = assetFieldsFromCi('host', { manufacturer: 'Lenovo', warrantyEnd: '2027-05-01', purchaseDate: '2024-05-01' });
    expect(fields.warranty?.startsAt).toBe('2024-05-01');
    expect(fields.warranty?.verifiedAt).toBeNull();
  });

  it('maps an EoX lookup onto the asset end of life', () => {
    expect(
      endOfLifeFromAttributes({ endOfSale: '2023-01-31', endOfSupport: '2028-01-31', eolSource: 'vendor_api', eolVerifiedAt: '2026-11-07T08:00:00Z' }),
    ).toEqual({
      endOfSale: '2023-01-31',
      endOfSoftwareMaintenance: null,
      endOfSupport: '2028-01-31',
      source: 'vendor_api',
      verifiedAt: '2026-11-07T08:00:00.000Z',
    });
    expect(endOfLifeFromAttributes({ endOfSupport: 'soon' })).toBeNull();
    expect(assetFieldsFromCi('network_device', { endOfSoftwareMaintenance: '2027-07-31' }).endOfLife?.source).toBe('vendor_api');
  });
});
