// T-173 REQ-CMDB-017 REQ-CMDB-019 — book value and reorder point offline: straight line falls evenly to the residual
// over the useful life and stops there; double-declining balance falls faster but not below the residual; `none` keeps
// the cost; whole months are counted between the purchase date and the day; no cost or date means no value; a spare is
// low when what is on hand has fallen to its reorder point.
import { describe, expect, it } from 'vitest';
import { belowReorderPoint, bookValue, monthsBetween } from './asset.js';

describe('asset value', () => {
  it('counts whole months', () => {
    expect(monthsBetween('2024-01-15', '2024-02-14')).toBe(0);
    expect(monthsBetween('2024-01-15', '2024-02-15')).toBe(1);
    expect(monthsBetween('2024-01-15', '2027-01-15')).toBe(36);
    expect(monthsBetween('2025-01-01', '2024-01-01')).toBe(0);
  });

  it('depreciates by straight line, declining balance or not at all', () => {
    const straight = { method: 'straight_line' as const, usefulLifeMonths: 60, residualValue: 1_000 };
    expect(bookValue(13_000, '2024-01-01', straight, '2024-01-01')).toBe(13_000);
    expect(bookValue(13_000, '2024-01-01', straight, '2026-07-01')).toBe(7_000);
    expect(bookValue(13_000, '2024-01-01', straight, '2031-01-01')).toBe(1_000);
    const declining = { method: 'declining_balance' as const, usefulLifeMonths: 60, residualValue: 1_000 };
    const half = bookValue(13_000, '2024-01-01', declining, '2026-07-01') ?? 0;
    expect(half).toBeLessThan(7_000);
    expect(half).toBeGreaterThan(1_000);
    expect(bookValue(13_000, '2024-01-01', declining, '2031-01-01')).toBe(1_000);
    expect(bookValue(13_000, '2024-01-01', { method: 'none', usefulLifeMonths: 1, residualValue: 0 }, '2030-01-01')).toBe(13_000);
    expect(bookValue(null, '2024-01-01', straight, '2026-01-01')).toBeNull();
    expect(bookValue(13_000, null, straight, '2026-01-01')).toBeNull();
    // A residual above the cost is read as the cost: nothing to depreciate.
    expect(bookValue(500, '2024-01-01', straight, '2026-01-01')).toBe(500);
  });

  it('flags a spare at or below its reorder point', () => {
    expect(belowReorderPoint({ onHand: 2, reorderPoint: 2 })).toBe(true);
    expect(belowReorderPoint({ onHand: 3, reorderPoint: 2 })).toBe(false);
    expect(belowReorderPoint(null)).toBe(false);
  });
});
