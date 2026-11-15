// T-663 REQ-PERF-007 REQ-UI-037 (ADR-077) — what the twin's host and its worker share: the open rack, the labels the
// scene projects (selected, hovered and the focus root, once each), and the plain fields forwarded for an input event.
import { describe, expect, it } from 'vitest';
import type { FacilityModel, GraphModel } from '@/lib/twin-model';
import { labelAnchors, openRackId } from './twin-selection';
import { forwardEvent } from './worker/protocol';

const facility = {
  racks: [
    { id: 'rack-1', labelPosition: [1, 2, 3] },
    { id: 'rack-2', labelPosition: [4, 5, 6] },
  ],
  devices: [{ id: 'srv-1', rackId: 'rack-2' }],
} as unknown as FacilityModel;

const graph = {
  nodes: [
    { id: 'db-1', isRoot: true, labelPosition: [0, 9, 0] },
    { id: 'app-1', isRoot: false, labelPosition: [1, 8, 1] },
  ],
} as unknown as GraphModel;

describe('openRackId', () => {
  it('is the selected rack, or the rack of the selected device, and nothing otherwise', () => {
    expect(openRackId(facility, { kind: 'rack', id: 'rack-1' })).toBe('rack-1');
    expect(openRackId(facility, { kind: 'device', id: 'srv-1' })).toBe('rack-2');
    expect(openRackId(facility, { kind: 'node', id: 'db-1' })).toBeNull();
    expect(openRackId(facility, null)).toBeNull();
  });
});

describe('labelAnchors', () => {
  it('shows the selected and hovered racks or nodes and the focus root, each once', () => {
    expect(labelAnchors(facility, graph, { kind: 'rack', id: 'rack-1' }, { kind: 'node', id: 'app-1' })).toEqual([
      { key: 'rack-1', kind: 'rack', position: [1, 2, 3] },
      { key: 'app-1', kind: 'node', position: [1, 8, 1] },
      { key: 'db-1', kind: 'node', position: [0, 9, 0] },
    ]);
    // The root hovered as well is still one label; a device has no label of its own.
    expect(labelAnchors(facility, graph, { kind: 'device', id: 'srv-1' }, { kind: 'node', id: 'db-1' }).map((a) => a.key)).toEqual(['db-1']);
    expect(labelAnchors(facility, null, null, null)).toEqual([]);
  });
});

describe('forwardEvent', () => {
  it('keeps the plain fields of a pointer or wheel event and zeroes the ones it lacks', () => {
    const wheel = new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, ctrlKey: true, clientX: 10, clientY: 20 });
    const forwarded = forwardEvent(wheel);
    expect(forwarded).toMatchObject({ deltaY: 120, ctrlKey: true, clientX: 10, clientY: 20, pointerId: 0, pointerType: 'mouse' });
    // Structured clone, as postMessage does it: nothing that cannot cross to the worker.
    expect(structuredClone(forwarded)).toEqual(forwarded);
  });
});
