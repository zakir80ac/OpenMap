// T-520 REQ-DCIM-001 (ADR-056) — the cabling contract: endpoint validation on and off patch panels, the cable input
// refusing a cable with both ends on one port, and the trace through panels to the far end, stopping at an unpatched
// panel side and on a mis-patched loop.
import { CABLING } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { cableInputSchema, endpointProblem, traceCable, type CableEndpoint, type CableLink } from './cabling.js';

const SWITCH = '00000000-0000-4000-8000-000000000001';
const PANEL_1 = '00000000-0000-4000-8000-000000000002';
const PANEL_2 = '00000000-0000-4000-8000-000000000003';
const SERVER = '00000000-0000-4000-8000-000000000004';
const panels = new Set([PANEL_1, PANEL_2]);
const isPanel = (id: string): boolean => panels.has(id);

function end(ciId: string, port: string | null, side: 'front' | 'rear' | null = null): CableEndpoint {
  return { ciId, port, side };
}
function cable(id: string, a: CableEndpoint, b: CableEndpoint): CableLink {
  return { id, via: 'cable', a, b };
}

// switch Gi1/0/1 → panel 1 position 4 front; panel 1 rear 4 → (trunk) → panel 2 rear 4; panel 2 front 4 → server eth0
const path: CableLink[] = [
  cable('patch-1', end(SWITCH, 'Gi1/0/1'), end(PANEL_1, '4', 'front')),
  cable('trunk-1', end(PANEL_1, '4', 'rear'), end(PANEL_2, '4', 'rear')),
  cable('patch-2', end(PANEL_2, '4', 'front'), end(SERVER, 'eth0')),
];

describe('cabling contract', () => {
  it('validates endpoints on and off patch panels', () => {
    expect(endpointProblem(end(SWITCH, 'Gi1/0/1'), null)).toBeNull();
    expect(endpointProblem(end(SWITCH, 'Gi1/0/1', 'front'), null)).toContain('only a patch panel');
    expect(endpointProblem(end(PANEL_1, '4', 'front'), 24)).toBeNull();
    expect(endpointProblem(end(PANEL_1, '4'), 24)).toContain('needs a side');
    expect(endpointProblem(end(PANEL_1, '25', 'rear'), 24)).toContain('1 to 24');
    expect(endpointProblem(end(PANEL_1, 'A', 'rear'), 24)).toContain('1 to 24');
  });

  it('refuses a cable whose two ends are the same port', () => {
    const same = end(SWITCH, 'Gi1/0/1');
    const parsed = cableInputSchema.safeParse({ label: 'C-1', kind: 'patch', media: 'cat6a', lengthM: 2, colour: null, a: same, b: same });
    expect(parsed.success).toBe(false);
    const ok = cableInputSchema.safeParse({ label: 'C-1', kind: 'patch', media: 'cat6a', lengthM: 2, colour: null, a: same, b: end(PANEL_1, '1', 'front') });
    expect(ok.success).toBe(true);
  });

  it('traces from a switch port through two panels to the server, and back', () => {
    const forward = traceCable(end(SWITCH, 'Gi1/0/1'), path, isPanel);
    expect(forward.complete).toBe(true);
    expect(forward.looped).toBe(false);
    expect(forward.hops.map((h) => h.link.id)).toEqual(['patch-1', 'trunk-1', 'patch-2']);
    expect(forward.hops.at(-1)?.to).toEqual(end(SERVER, 'eth0'));

    const back = traceCable(end(SERVER, 'eth0'), path, isPanel);
    expect(back.hops.map((h) => h.link.id)).toEqual(['patch-2', 'trunk-1', 'patch-1']);
    expect(back.hops.at(-1)?.to).toEqual(end(SWITCH, 'Gi1/0/1'));

    // From the middle: a panel position's front leads out to the device patched there.
    const middle = traceCable(end(PANEL_2, '4', 'front'), path, isPanel);
    expect(middle.hops.map((h) => h.link.id)).toEqual(['patch-2']);
    expect(middle.complete).toBe(true);
  });

  it('stops incomplete at a panel side with nothing patched, and empty on a free port', () => {
    const partial = traceCable(end(SWITCH, 'Gi1/0/1'), path.slice(0, 2), isPanel);
    expect(partial.hops.map((h) => h.link.id)).toEqual(['patch-1', 'trunk-1']);
    expect(partial.complete).toBe(false);
    expect(partial.looped).toBe(false);

    const free = traceCable(end(SWITCH, 'Gi1/0/2'), path, isPanel);
    expect(free.hops).toEqual([]);
    expect(free.complete).toBe(false);
  });

  it('reports a mis-patched loop instead of walking forever', () => {
    // panel 1 rear 4 ↔ panel 2 rear 4 and panel 2 front 4 ↔ panel 1 front 5, panel 1 rear 5 ↔ panel 2 front... back to 4
    const loop: CableLink[] = [
      cable('l1', end(PANEL_1, '4', 'rear'), end(PANEL_2, '4', 'rear')),
      cable('l2', end(PANEL_2, '4', 'front'), end(PANEL_1, '5', 'front')),
      cable('l3', end(PANEL_1, '5', 'rear'), end(PANEL_1, '4', 'front')),
    ];
    const trace = traceCable(end(PANEL_1, '4', 'rear'), loop, isPanel);
    expect(trace.looped).toBe(true);
    expect(trace.complete).toBe(false);
    expect(trace.hops.length).toBeLessThanOrEqual(CABLING.maxTraceHops);
  });
});
