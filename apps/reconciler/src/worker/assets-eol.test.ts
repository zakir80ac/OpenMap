// T-357 REQ-CMDB-024 — a warranty/EoX lookup on a hardware CI reaches the register row (ADR-043): the vendor-sourced
// end of life and the warranty with its start and verification instant; CIs without the dates carry none.
import type { Ci } from '@openmap/contracts';
import { describe, expect, it } from 'vitest';
import { assetRowFor } from './assets.js';

function ci(attributes: Record<string, unknown>): Ci {
  return {
    id: '0f6f4f1e-0d4e-4c7a-9f0e-000000000011',
    tenantId: '0f6f4f1e-0d4e-4c7a-9f0e-000000000002',
    type: 'network_device',
    identity: { serialNumber: 'FOC1' },
    name: 'ryd-dist-01',
    displayName: 'ryd-dist-01',
    code: 'NET-DIST-1',
    layer: 'network',
    lifecycle: 'managed',
    attributes,
    tags: [],
    source: { collectorId: 'warranty', nodeId: 'node-1', runId: 'run-1', confidence: 0.9 },
    observedAt: '2026-11-07T08:00:00.000Z',
    validFrom: '2026-11-07T08:00:00.000Z',
    validTo: null,
    checksum: 'a'.repeat(64),
  } as Ci;
}

describe('warranty and EoX lookups in the register row', () => {
  it('carries the vendor end of life and the verified warranty', () => {
    const row = assetRowFor(
      ci({
        manufacturer: 'Cisco Systems',
        serialNumber: 'FOC1',
        warrantyProvider: 'Cisco',
        warrantyLevel: 'WARR-LTD-LIFE-HW',
        warrantyEnd: '2028-08-23',
        warrantyVerifiedAt: '2026-11-07T08:00:00Z',
        endOfSale: '2025-01-31',
        endOfSoftwareMaintenance: '2026-01-31',
        endOfSupport: '2031-01-31',
        eolSource: 'vendor_api',
        eolVerifiedAt: '2026-11-07T08:00:00Z',
      }),
    );
    expect(row).not.toBeNull();
    expect(JSON.parse(row?.endOfLife ?? 'null')).toEqual({
      endOfSale: '2025-01-31',
      endOfSoftwareMaintenance: '2026-01-31',
      endOfSupport: '2031-01-31',
      source: 'vendor_api',
      verifiedAt: '2026-11-07T08:00:00.000Z',
    });
    expect(JSON.parse(row?.warranty ?? 'null')).toMatchObject({ provider: 'Cisco', endsAt: '2028-08-23', verifiedAt: '2026-11-07T08:00:00.000Z' });
  });

  it('leaves end of life empty when the lookup reported none', () => {
    expect(assetRowFor(ci({ manufacturer: 'Cisco Systems', warrantyEnd: '2028-08-23' }))?.endOfLife).toBeNull();
  });
});
