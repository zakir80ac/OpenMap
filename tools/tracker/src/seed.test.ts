// T-003 REQ-CORE-007
import { describe, expect, it } from 'vitest';
import { materialise, nextId, parseCapabilityMap, platformSeeds, seedsFromSpec } from './seed.js';

const map = [
  '## 1. Discovery',
  '| Device42 feature | OpenMap | Parity | WS |',
  '| --- | --- | --- | --- |',
  '| SNMP discovery | `collectors/snmp` | = | DISC |',
  '| Not a row | x | = | NOPE |',
  '## 2. CMDB',
  '| Assets | `assetRecordSchema` | + | CMDB |',
].join('\n');

describe('tracker seed', () => {
  it('parses capability map rows by section and workstream', () => {
    const rows = parseCapabilityMap(map);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.section).toBe('1. Discovery');
    expect(rows[1]?.workstream).toBe('CMDB');
  });
  it('allocates sequential ids per workstream', () => {
    const added = materialise(platformSeeds().slice(0, 3), []);
    expect(added.map((r) => r.id)).toEqual(['REQ-CORE-001', 'REQ-CORE-002', 'REQ-CORE-003']);
    expect(nextId('CORE', added)).toBe('REQ-CORE-004');
  });
  it('does not duplicate rows with the same workstream and title', () => {
    const first = materialise(platformSeeds(), []);
    const again = materialise(platformSeeds(), first);
    expect(again).toHaveLength(0);
  });
  it('imports REQ rows from a spec table', () => {
    const spec = ['## IPAM', '| ID | WS | Title | Description | AC | Priority |', '| REQ | IPAM | Next free IP | API | returns | P0 |'].join('\n');
    const rows = seedsFromSpec(spec);
    expect(rows[0]?.title).toBe('Next free IP');
    expect(rows[0]?.priority).toBe('P0');
  });
});
