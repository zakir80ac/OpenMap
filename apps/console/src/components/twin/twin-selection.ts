// REQ-UI-029 REQ-UI-037 REQ-PERF-007 — what the twin's scene and its host share without three.js: the selection, the
// open rack, and the labels the scene projects to the screen for the host to draw as DOM (ADR-077: the scene may run
// in a worker, where there is no DOM).
import type { FacilityModel, GraphModel, Vec3 } from '@/lib/twin-model';

export interface TwinSelection {
  /** REQ-UI-037: a device inside an open rack is selected on its own, to drill down from it. */
  kind: 'rack' | 'device' | 'node';
  id: string;
}

/** The rack whose devices take clicks: the selected rack, or the rack of the selected device. */
export function openRackId(facility: FacilityModel, selected: TwinSelection | null): string | null {
  if (selected?.kind === 'rack') return selected.id;
  if (selected?.kind === 'device') return facility.devices.find((d) => d.id === selected.id)?.rackId ?? null;
  return null;
}

/** A label the scene shows: the selected and hovered rack or node, and the focus CI of the dependency graph. */
export interface LabelAnchor {
  key: string;
  kind: 'rack' | 'node';
  position: Vec3;
}

/** A label projected to the canvas, in CSS pixels from its top left corner. */
export interface ProjectedLabel {
  key: string;
  kind: 'rack' | 'node';
  x: number;
  y: number;
}

/** The labels to show, at most once each: selected first, then hovered, then the focus root. */
export function labelAnchors(facility: FacilityModel, graph: GraphModel | null, selected: TwinSelection | null, hovered: TwinSelection | null): LabelAnchor[] {
  const shown: LabelAnchor[] = [];
  const push = (selection: TwinSelection | null): void => {
    if (selection === null || shown.some((s) => s.key === selection.id)) return;
    if (selection.kind === 'rack') {
      const rack = facility.racks.find((r) => r.id === selection.id);
      if (rack !== undefined) shown.push({ key: rack.id, kind: 'rack', position: rack.labelPosition });
    } else if (selection.kind === 'node') {
      const node = graph?.nodes.find((n) => n.id === selection.id);
      if (node !== undefined) shown.push({ key: node.id, kind: 'node', position: node.labelPosition });
    }
  };
  push(selected);
  push(hovered);
  const root = graph?.nodes.find((n) => n.isRoot);
  if (root !== undefined && !shown.some((s) => s.key === root.id)) shown.push({ key: root.id, kind: 'node', position: root.labelPosition });
  return shown;
}
