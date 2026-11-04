// T-125 REQ-UI-033 — the pure stack model: planes in contract order from the data centre up, one equipment family
// per layer, units by share, vendor marks, counts, health and visibility carried, the overview and focus poses.
import { LAYER_STACK } from '@openmap/constants';
import { CI_LAYERS } from '@openmap/contracts';
import { describe, expect, it } from 'vitest';
import { LAYER_EQUIPMENT, LAYER_MARKS, STACK_ORDER, buildStackModel, focusPose, planePosition, unitsFor } from './layer-stack-model';

const everyVisible = Object.fromEntries(CI_LAYERS.map((l) => [l, true])) as Record<(typeof CI_LAYERS)[number], boolean>;

describe('buildStackModel', () => {
  it('stacks the twelve planes in contract order from the data centre up with one equipment family each', () => {
    const model = buildStackModel(new Map(), everyVisible);
    expect(model.planes.map((p) => p.layer)).toEqual([...STACK_ORDER]);
    expect(model.planes[0]?.layer).toBe('dc');
    expect(model.planes[model.planes.length - 1]?.layer).toBe('unknown');
    for (const plane of model.planes) {
      expect(plane.position).toEqual(planePosition(plane.index));
      expect(plane.position[1]).toBeCloseTo(plane.index * LAYER_STACK.stepM);
      expect(plane.labelAnchor[0]).toBeCloseTo(-LAYER_STACK.planeWidthM / LAYER_STACK.halfDivisor);
      expect(plane.equipment).toBe(LAYER_EQUIPMENT[plane.layer]);
      expect(plane.marks).toBe(LAYER_MARKS[plane.layer]);
    }
    expect(model.height).toBeCloseTo((CI_LAYERS.length - 1) * LAYER_STACK.stepM);
    expect(model.overview.target[1]).toBeCloseTo(model.height / LAYER_STACK.halfDivisor);
    expect(model.overview.zoom).toBe(LAYER_STACK.overviewZoom);
  });
  it('frames a focused plane closer, from the same direction, with the equipment lifted into view', () => {
    const model = buildStackModel(new Map(), everyVisible);
    const storage = model.planes.find((p) => p.layer === 'storage');
    if (storage === undefined) throw new Error('storage plane missing');
    const pose = focusPose(storage);
    expect(pose.zoom).toBeGreaterThan(model.overview.zoom);
    expect(pose.target[1]).toBeCloseTo(storage.position[1] + LAYER_STACK.focusLiftM);
    expect(pose.position[1]).toBeGreaterThan(pose.target[1]);
  });
  it('repeats equipment by each layer share of the largest count and carries counts, health and visibility', () => {
    const counts = new Map([
      ['hardware', { count: 200, healthy: 150, degraded: 30, down: 20 }],
      ['saas', { count: 50, healthy: 50, degraded: 0, down: 0 }],
    ] as const);
    const model = buildStackModel(counts, { ...everyVisible, saas: false });
    const hardware = model.planes.find((p) => p.layer === 'hardware');
    const saas = model.planes.find((p) => p.layer === 'saas');
    expect(hardware?.share).toBe(1);
    expect(hardware?.units).toBe(LAYER_STACK.maxUnits);
    expect(saas?.share).toBeCloseTo(0.25);
    expect(unitsFor(0)).toBe(1);
    expect(hardware?.down).toBe(20);
    expect(saas?.visible).toBe(false);
    expect(model.planes.find((p) => p.layer === 'dc')?.count).toBe(0);
  });
  it('names a platform for every layer that has one, as an icon only where the catalogue carries the mark', () => {
    expect(LAYER_MARKS.virtualization.some((m) => m.kind === 'icon' && m.slug === 'vmware')).toBe(true);
    expect(LAYER_MARKS.os.some((m) => m.kind === 'icon' && m.slug === 'redhat')).toBe(true);
    expect(LAYER_MARKS.saas.every((m) => m.kind === 'word')).toBe(true);
  });
});
