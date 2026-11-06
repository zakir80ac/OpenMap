// T-178 REQ-CMDB-020 (ADR-034) — receiving offline: which plan statuses take deliveries, what is still outstanding on a
// line, and the units a person types or scans (one per line, serial then an optional tag after a comma or a tab; blank
// lines skipped; a repeated serial, an empty box and more units than are outstanding are refused).
import { describe, expect, it } from 'vitest';
import { canReceive, outstanding, parseReceivedUnits, planReceiptSchema } from './asset.js';

describe('receiving against a plan line', () => {
  it('takes deliveries on approved and building plans and counts what is still to arrive', () => {
    expect(['draft', 'approved', 'building', 'live', 'cancelled'].filter(canReceive)).toEqual(['approved', 'building']);
    expect(outstanding({ quantity: 3, received: 1 })).toBe(2);
    expect(outstanding({ quantity: 2, received: 2 })).toBe(0);
    expect(outstanding({ quantity: 1, received: 4 })).toBe(0);
  });

  it('reads serials with optional tags, one unit per line', () => {
    const text = 'SN-A, TAG-1\r\n\n  SN-B  \nSN-C\tTAG-3\n';
    expect(parseReceivedUnits(text, 3)).toEqual({
      units: [
        { serialNumber: 'SN-A', assetTag: 'TAG-1' },
        { serialNumber: 'SN-B', assetTag: null },
        { serialNumber: 'SN-C', assetTag: 'TAG-3' },
      ],
      problem: null,
    });
  });

  it('refuses an empty box, a repeated serial and more units than are outstanding', () => {
    expect(parseReceivedUnits(' \n\n', 2).problem).toEqual({ kind: 'empty' });
    expect(parseReceivedUnits('SN-A\nSN-B\nSN-A', 5).problem).toEqual({ kind: 'duplicate', serialNumber: 'SN-A' });
    expect(parseReceivedUnits('SN-A\nSN-B\nSN-C', 2).problem).toEqual({ kind: 'too_many', count: 3, outstanding: 2 });
  });

  it('describes a receipt with at least one unit', () => {
    const receipt = {
      id: '0b5f0a59-5d1e-4d43-9f3f-1d1f1b0f9a01',
      tenantId: '0b5f0a59-5d1e-4d43-9f3f-1d1f1b0f9a02',
      planId: '0b5f0a59-5d1e-4d43-9f3f-1d1f1b0f9a03',
      bomLineId: '0b5f0a59-5d1e-4d43-9f3f-1d1f1b0f9a04',
      position: 0,
      quantity: 1,
      receivedOn: '2026-11-06',
      receivedBy: 'operator',
      reference: 'PO-1',
      locationCiId: null,
      assetIds: ['0b5f0a59-5d1e-4d43-9f3f-1d1f1b0f9a05'],
      createdAt: '2026-11-06T10:00:00.000Z',
    };
    expect(planReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(planReceiptSchema.safeParse({ ...receipt, assetIds: [] }).success).toBe(false);
  });
});
