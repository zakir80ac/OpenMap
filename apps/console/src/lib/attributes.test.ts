// T-062 REQ-UI-008 REQ-CMDB-037 — attribute classification, stable diff and relationship grouping for the CI detail.
import { CI_LAYERS } from '@openmap/contracts';
import { describe, expect, it } from 'vitest';
import { codeFor, diffAttributes, groupRelationships, isIsoDate, labelableLayers, stableStringify, valueKind } from './attributes';

describe('codeFor', () => {
  it('uses the layer prefix and the business-service prefix', () => {
    expect(codeFor({ layer: 'network_security', type: 'network_device', name: 'arista-spine1.ryd.local' })).toBe('NET-ARISTA-SPINE1');
    expect(codeFor({ layer: 'applications', type: 'business_service', name: 'Online banking' })).toBe('BS-ONLINE-BANKING');
    expect(codeFor({ layer: 'unknown', type: 'something-new', name: 'x' })).toBe('UNK-X');
  });
});

describe('valueKind', () => {
  it('classifies scalars, dates, lists and objects', () => {
    expect(valueKind(null)).toBe('null');
    expect(valueKind(undefined)).toBe('null');
    expect(valueKind(true)).toBe('boolean');
    expect(valueKind(42)).toBe('number');
    expect(valueKind('2026-10-22T09:00:00.000Z')).toBe('date');
    expect(valueKind('2026-10-22')).toBe('date');
    expect(valueKind('R12 U18')).toBe('text');
    expect(valueKind(['a', 'b'])).toBe('list');
    expect(valueKind({ a: 1 })).toBe('object');
  });
  it('rejects date-shaped strings that are not real instants', () => {
    expect(isIsoDate('2026-13-45')).toBe(false);
    expect(isIsoDate('10.20.4.18')).toBe(false);
  });
});

describe('diffAttributes', () => {
  it('reports added, removed and changed keys in sorted order and skips equal ones', () => {
    const before = { os: 'Ubuntu 22.04', rack: 'R9', cores: 64, tags: ['a', 'b'], nested: { b: 1, a: 2 } };
    const after = { os: 'Ubuntu 24.04', cores: 64, tags: ['a', 'b'], nested: { a: 2, b: 1 }, fw: 'iDRAC 7.10' };
    const rows = diffAttributes(before, after);
    expect(rows.map((r) => [r.key, r.change])).toEqual([
      ['fw', 'added'],
      ['os', 'changed'],
      ['rack', 'removed'],
    ]);
    expect(rows.find((r) => r.key === 'os')).toMatchObject({ before: 'Ubuntu 22.04', after: 'Ubuntu 24.04' });
  });
  it('serialises values with sorted keys so key order is not a change', () => {
    expect(stableStringify({ b: [1, { d: 1, c: null }], a: 'x' })).toBe('{"a":"x","b":[1,{"c":null,"d":1}]}');
  });
});

describe('groupRelationships', () => {
  const me = { id: 'me', name: 'me', displayName: 'Me', code: 'SRV-ME', type: 'host', layer: 'hardware' as const, health: 'healthy' as const };
  const other = (id: string) => ({ ...me, id, displayName: id });
  it('groups by type, largest group first, and resolves the other end and direction', () => {
    const groups = groupRelationships(
      [
        { type: 'powered_by', from: me, to: other('pdu-a') },
        { type: 'runs_on', from: other('vm-1'), to: me },
        { type: 'powered_by', from: me, to: other('pdu-b') },
      ],
      'me',
    );
    expect(groups.map((g) => g.type)).toEqual(['powered_by', 'runs_on']);
    expect(groups[0]?.rows.map((r) => r.other.id)).toEqual(['pdu-a', 'pdu-b']);
    expect(groups[0]?.rows[0]?.outgoing).toBe(true);
    expect(groups[1]?.rows[0]?.outgoing).toBe(false);
  });
});

describe('labelableLayers', () => {
  it('offers every layer but unknown', () => {
    const layers = labelableLayers(CI_LAYERS);
    expect(layers).toHaveLength(CI_LAYERS.length - 1);
    expect(layers).not.toContain('unknown');
  });
});
