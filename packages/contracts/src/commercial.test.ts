// T-181 REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 (ADR-035) — the commercial contract offline: a contract's
// kind from its attributes, days to its end and its notice date, documents read leniently, and the inputs a person
// enters for a contract, a vendor and a cost centre (dates in order, a cost or budget with its currency).
import { describe, expect, it } from 'vitest';
import {
  contractDocuments,
  contractInputSchema,
  contractKindOf,
  costCentreInputSchema,
  daysToEnd,
  noticeBy,
  vendorInputSchema,
} from './commercial.js';

const contract = {
  vendorId: '0b5f0a59-5d1e-4d43-9f3f-1d1f1b0f9a01',
  costCentreId: null,
  contractNumber: 'DELL-1',
  kind: 'support' as const,
  title: 'ProSupport Plus',
  level: 'four_hour' as const,
  responseMinutes: 240,
  startsAt: '2025-01-01',
  endsAt: '2027-12-31',
  autoRenews: false,
  noticeDays: 90,
  annualCost: 120_000,
  currency: 'SAR',
  documents: [{ title: 'Signed agreement', location: 'https://dms.example.org/contracts/DELL-1.pdf' }],
};

describe('commercial records', () => {
  it('reads a contract kind, its days to end and its notice date', () => {
    expect(contractKindOf({ kind: 'lease' })).toBe('lease');
    expect(contractKindOf({ level: 'four_hour' })).toBe('support');
    expect(contractKindOf({ kind: 'unheard-of' })).toBe('other');
    expect(daysToEnd('2026-12-31', '2026-11-06')).toBe(55);
    expect(daysToEnd('2026-11-06', '2026-11-06T23:59:00Z')).toBe(0);
    expect(daysToEnd('2026-11-01', '2026-11-06')).toBe(-5);
    expect(noticeBy('2027-12-31', 90)).toBe('2027-10-02');
    expect(noticeBy('2027-12-31', null)).toBeNull();
  });

  it('keeps well-formed documents and drops the rest', () => {
    expect(contractDocuments([{ title: 'SOW', location: '\\\\files\\contracts\\sow.pdf' }, { title: '' }, 'x'])).toEqual([
      { title: 'SOW', location: '\\\\files\\contracts\\sow.pdf' },
    ]);
    expect(contractDocuments(null)).toEqual([]);
  });

  it('validates what a person enters for a contract, a vendor and a cost centre', () => {
    expect(contractInputSchema.safeParse(contract).success).toBe(true);
    expect(contractInputSchema.safeParse({ ...contract, endsAt: '2024-12-31' }).success).toBe(false);
    expect(contractInputSchema.safeParse({ ...contract, currency: null }).success).toBe(false);
    expect(contractInputSchema.safeParse({ ...contract, kind: 'lease', level: null, responseMinutes: null }).success).toBe(true);
    expect(vendorInputSchema.safeParse({ name: 'Vertiv', category: 'facilities', supportPortal: null, accountManager: null }).success).toBe(true);
    expect(vendorInputSchema.safeParse({ name: ' ', category: null, supportPortal: null, accountManager: null }).success).toBe(false);
    const centre = { code: 'CC-9000', name: 'Payments', kind: 'department' as const, owner: 'Payments', annualBudget: 5_000_000, currency: 'SAR' };
    expect(costCentreInputSchema.safeParse(centre).success).toBe(true);
    expect(costCentreInputSchema.safeParse({ ...centre, currency: null }).success).toBe(false);
    expect(costCentreInputSchema.safeParse({ ...centre, kind: 'customer', annualBudget: null, currency: null }).success).toBe(true);
  });
});
