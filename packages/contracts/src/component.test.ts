// T-192 REQ-CMDB-014 — part lists on observed CIs, their diff between sweeps and their totals (ADR-037).
import { describe, expect, it } from 'vitest';
import { observedCiSchema } from './ci.js';
import { componentChangedSchema, componentSchema, componentTotals, diffComponents, normalizeComponents } from './component.js';

const GIB = 1024 ** 3;

describe('components', () => {
  it('validates parts, keeps one per kind and slot and rides on an observed CI', () => {
    expect(componentSchema.safeParse({ kind: 'fan', slot: '1' }).success).toBe(false);
    expect(componentSchema.safeParse({ kind: 'nic', slot: '' }).success).toBe(false);
    const parts = normalizeComponents([
      { kind: 'disk', slot: 'sda', model: 'old', capacityBytes: 10 },
      { kind: 'disk', slot: 'sda', model: 'Samsung PM893', serialNumber: 'S1', capacityBytes: 960 * GIB },
      { kind: 'cpu', slot: '0', model: 'Xeon Gold 6338', details: { cores: 32, threads: 64 } },
    ]);
    expect(parts).toHaveLength(2);
    expect(parts.find((p) => p.kind === 'disk')?.model).toBe('Samsung PM893');
    const observed = { type: 'host', identity: { fqdn: 'a' }, name: 'a', attributes: {}, tags: [], externalIds: [], observedAt: new Date(0).toISOString() };
    expect(observedCiSchema.safeParse({ ...observed, components: parts }).success).toBe(true);
    expect(observedCiSchema.safeParse(observed).success).toBe(true);
    expect(observedCiSchema.safeParse({ ...observed, components: [{ kind: 'cpu' }] }).success).toBe(false);
  });

  it('diffs added, removed and replaced parts by kind and slot', () => {
    const before = [
      { kind: 'disk' as const, slot: 'sda', serialNumber: 'S1' },
      { kind: 'disk' as const, slot: 'sdb', serialNumber: 'S2' },
      { kind: 'memory' as const, slot: 'DIMM_A1' },
    ];
    const after = [
      { kind: 'disk' as const, slot: 'sda', serialNumber: 'S9' },
      { kind: 'memory' as const, slot: 'DIMM_A1', serialNumber: 'M1' },
      { kind: 'nic' as const, slot: 'eno1' },
    ];
    const d = diffComponents(before, after);
    expect(d.added.map((c) => c.slot)).toEqual(['eno1']);
    expect(d.removed.map((c) => c.slot)).toEqual(['sdb']);
    // A serial seen for the first time is not a replacement; a different serial is.
    expect(d.replaced.map((r) => [r.before.serialNumber, r.after.serialNumber])).toEqual([['S1', 'S9']]);
  });

  it('totals counts per kind and memory and disk capacity', () => {
    const totals = componentTotals([
      { kind: 'memory', capacityBytes: 32 * GIB },
      { kind: 'memory', capacityBytes: 32 * GIB },
      { kind: 'disk', capacityBytes: 960 * GIB },
      { kind: 'cpu' },
    ]);
    expect(totals.count.memory).toBe(2);
    expect(totals.count.cpu).toBe(1);
    expect(totals.count.hba).toBe(0);
    expect(totals.memoryBytes).toBe(64 * GIB);
    expect(totals.diskBytes).toBe(960 * GIB);
    expect(
      componentChangedSchema.safeParse({ ciId: '00000000-0000-4000-8000-000000000001', added: [{ kind: 'cpu', slot: '0' }], removed: [], replaced: [] }).success,
    ).toBe(true);
  });
});
