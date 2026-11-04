// REQ-UI-033 — pure model of the Layers stack (ADR-021): twelve planes stacked in contract order, the data centre at
// the bottom and SaaS at the top, each knowing the equipment it holds, how many units, and its vendor marks; the
// overview camera and the focus pose for any plane. No three.js here, so it is unit-testable.
import { GEOMETRY, LAYER_STACK } from '@openmap/constants';
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';

export type Vec3 = readonly [number, number, number];

/** Equipment families a plane shows when focused; each layer has one, chosen for what the layer holds. */
export type EquipmentKind = 'cabinets' | 'network' | 'servers' | 'storage' | 'hypervisor' | 'cloud' | 'os' | 'containers' | 'database' | 'applications' | 'saas' | 'unknown';

export const LAYER_EQUIPMENT: Record<CiLayer, EquipmentKind> = {
  dc: 'cabinets',
  network_security: 'network',
  hardware: 'servers',
  storage: 'storage',
  virtualization: 'hypervisor',
  cloud: 'cloud',
  os: 'os',
  containers: 'containers',
  databases: 'database',
  applications: 'applications',
  saas: 'saas',
  unknown: 'unknown',
};

/** A vendor mark beside a layer: an icon from the CC0 catalogue, or the vendor's name where no icon may be used. */
export type Mark = { kind: 'icon'; slug: string } | { kind: 'word'; text: string };

/**
 * Representative platforms per layer, in the order the collectors support them (docs/CAPABILITY-MAP.md). Icons come
 * from simple-icons (CC0); Microsoft, Azure, AWS, Oracle, Salesforce and ServiceNow withdrew their marks from it, so
 * those appear as names.
 */
export const LAYER_MARKS: Record<CiLayer, readonly Mark[]> = {
  dc: [],
  network_security: [
    { kind: 'icon', slug: 'cisco' },
    { kind: 'icon', slug: 'fortinet' },
    { kind: 'icon', slug: 'paloaltonetworks' },
  ],
  hardware: [
    { kind: 'icon', slug: 'dell' },
    { kind: 'icon', slug: 'hp' },
  ],
  storage: [
    { kind: 'icon', slug: 'netapp' },
    { kind: 'icon', slug: 'dell' },
  ],
  virtualization: [
    { kind: 'icon', slug: 'vmware' },
    { kind: 'icon', slug: 'nutanix' },
    { kind: 'word', text: 'Hyper-V' },
  ],
  cloud: [
    { kind: 'word', text: 'Azure' },
    { kind: 'word', text: 'AWS' },
    { kind: 'icon', slug: 'googlecloud' },
  ],
  os: [
    { kind: 'icon', slug: 'redhat' },
    { kind: 'word', text: 'Windows Server' },
    { kind: 'icon', slug: 'ubuntu' },
  ],
  containers: [
    { kind: 'icon', slug: 'kubernetes' },
    { kind: 'icon', slug: 'docker' },
  ],
  databases: [
    { kind: 'word', text: 'Oracle' },
    { kind: 'icon', slug: 'postgresql' },
    { kind: 'icon', slug: 'mongodb' },
  ],
  applications: [],
  saas: [
    { kind: 'word', text: 'Microsoft 365' },
    { kind: 'word', text: 'Salesforce' },
    { kind: 'word', text: 'ServiceNow' },
  ],
  unknown: [],
};

export interface LayerPlane {
  layer: CiLayer;
  /** Index from the bottom: the data centre is 0. */
  index: number;
  position: Vec3;
  size: Vec3;
  /** Where the label beside the plane anchors: the plane's front-left corner. */
  labelAnchor: Vec3;
  equipment: EquipmentKind;
  /** Units of equipment shown when focused: one at the smallest share, LAYER_STACK.maxUnits at the largest. */
  units: number;
  marks: readonly Mark[];
  /** Share of the stack's maximum count, 0..1. */
  share: number;
  count: number;
  healthy: number;
  degraded: number;
  down: number;
  visible: boolean;
}

export interface LayerCounts {
  count: number;
  healthy: number;
  degraded: number;
  down: number;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  zoom: number;
}

export interface StackModel {
  planes: LayerPlane[];
  overview: CameraPose;
  height: number;
}

/** Bottom to top: the contract's layer order, the data centre first; `unknown` on top. */
export const STACK_ORDER: readonly CiLayer[] = [...CI_LAYERS];

const X = GEOMETRY.axisX;
const Y = GEOMETRY.axisY;
const Z = GEOMETRY.axisZ;
const HALF = LAYER_STACK.halfDivisor;

export function unitsFor(share: number): number {
  return Math.max(1, Math.round(share * LAYER_STACK.maxUnits));
}

export function planePosition(index: number): Vec3 {
  return [0, index * LAYER_STACK.stepM, 0];
}

export function buildStackModel(counts: ReadonlyMap<CiLayer, LayerCounts>, visibility: Readonly<Record<CiLayer, boolean>>): StackModel {
  const max = Math.max(1, ...[...counts.values()].map((c) => c.count));
  const planes: LayerPlane[] = STACK_ORDER.map((layer, index) => {
    const c = counts.get(layer) ?? { count: 0, healthy: 0, degraded: 0, down: 0 };
    const share = c.count / max;
    const position = planePosition(index);
    return {
      layer,
      index,
      position,
      size: [LAYER_STACK.planeWidthM, LAYER_STACK.planeThicknessM, LAYER_STACK.planeDepthM],
      labelAnchor: [position[X] - LAYER_STACK.planeWidthM / HALF, position[Y] + LAYER_STACK.planeThicknessM, position[Z] + LAYER_STACK.planeDepthM / HALF],
      equipment: LAYER_EQUIPMENT[layer],
      units: unitsFor(share),
      marks: LAYER_MARKS[layer],
      share,
      count: c.count,
      healthy: c.healthy,
      degraded: c.degraded,
      down: c.down,
      visible: visibility[layer],
    };
  });
  const height = (STACK_ORDER.length - 1) * LAYER_STACK.stepM;
  const mid = height / HALF;
  return {
    planes,
    overview: {
      position: [LAYER_STACK.overviewOffset[X], mid + LAYER_STACK.overviewOffset[Y], LAYER_STACK.overviewOffset[Z]],
      target: [0, mid, 0],
      zoom: LAYER_STACK.overviewZoom,
    },
    height,
  };
}

/** The camera pose that frames one plane with its equipment: closer, from the same three-quarter direction. */
export function focusPose(plane: LayerPlane): CameraPose {
  const target: Vec3 = [plane.position[X], plane.position[Y] + LAYER_STACK.focusLiftM, plane.position[Z]];
  return {
    position: [target[X] + LAYER_STACK.focusOffset[X], target[Y] + LAYER_STACK.focusOffset[Y], target[Z] + LAYER_STACK.focusOffset[Z]],
    target,
    zoom: LAYER_STACK.focusZoom,
  };
}
