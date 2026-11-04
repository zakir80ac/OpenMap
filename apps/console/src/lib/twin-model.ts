// REQ-UI-029 — 3D digital twin model (ADR-018). Pure functions: the `racks` query becomes rooms, racks and device
// plates placed in metres (rows along z, positions along x, rooms in a grid), and an impact graph with a 2D layout
// becomes nodes and edges on the layer planes stacked above the floor. Nothing here touches WebGL, so it is unit
// tested like the 2D map model and runs the same on the main thread or in a worker.
import { BSM, GEOMETRY, TWIN } from '@openmap/constants';
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';
import { layerColor, stateColor, type HexColor } from '@openmap/ui';
import type { Rack } from './estate-queries';
import { nodeColor, predictedColor, type ImpactGraph, type MapNode } from './graph-layout';
import type { CiSummary, HealthState, PredictedState } from './queries';

export type Vec3 = readonly [number, number, number];

export interface DeviceSlab {
  id: string;
  rackId: string;
  name: string;
  ci: CiSummary;
  layer: CiLayer;
  startUnit: number;
  heightUnits: number;
  face: string;
  /** World centre. */
  position: Vec3;
  /** Box size (x, y, z) in metres. */
  size: Vec3;
  color: HexColor;
}

export interface RackBox {
  id: string;
  name: string;
  ci: Rack['ci'];
  roomId: string;
  row: string;
  position: number;
  units: number;
  occupiedUnits: number;
  ratedWatts: number;
  currentWatts: number;
  loadPercent: number;
  /** World centre of the rack body. */
  center: Vec3;
  size: Vec3;
  /** Where a floating label for the rack sits: above its top face. */
  labelPosition: Vec3;
  color: HexColor;
  devices: DeviceSlab[];
  feeds: Rack['powerFeeds'];
}

export interface RoomSlab {
  id: string;
  name: string;
  center: Vec3;
  size: Vec3;
  rackCount: number;
  rows: string[];
}

export interface FacilityModel {
  rooms: RoomSlab[];
  racks: RackBox[];
  devices: DeviceSlab[];
  /** Horizontal extent of everything placed, metres. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Tallest rack, metres. */
  maxHeightM: number;
  /** Centre of the facility on the ground plane. */
  center: Vec3;
}

const UNPLACED_ROOM_ID = 'unplaced';

function numberAttribute(attributes: Record<string, unknown>, key: string): number | null {
  const value = attributes[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | null {
  const value = attributes[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Load share of a rack from its feeds; 0 when no feed reports. */
export function loadPercentOf(rack: Rack): number {
  const rated = rack.powerFeeds.reduce((sum, f) => sum + f.ratedWatts, 0);
  const current = rack.powerFeeds.reduce((sum, f) => sum + f.currentWatts, 0);
  if (rated <= 0) return 0;
  return Math.min(BSM.percentScale, (current / rated) * BSM.percentScale);
}

/** Rack shell colour: healthy accent under light load, warning past loadWarnPercent, failure past loadHotPercent. */
export function rackColor(loadPercent: number, hasFeed: boolean): HexColor {
  if (!hasFeed) return stateColor('unknown');
  if (loadPercent >= TWIN.loadHotPercent) return stateColor('down');
  if (loadPercent >= TWIN.loadWarnPercent) return stateColor('degraded');
  return stateColor('healthy');
}

interface PlacedRack {
  rack: Rack;
  row: string;
  position: number;
}

function placeInRoom(racks: ReadonlyArray<Rack>): { rows: string[]; placed: Map<string, PlacedRack[]> } {
  const placed = new Map<string, PlacedRack[]>();
  racks.forEach((rack, index) => {
    const row = stringAttribute(rack.ci.attributes, 'row') ?? rack.row?.displayName ?? '';
    const position = numberAttribute(rack.ci.attributes, 'position') ?? index + 1;
    const list = placed.get(row) ?? [];
    list.push({ rack, row, position });
    placed.set(row, list);
  });
  const rows = [...placed.keys()].sort((a, b) => a.localeCompare(b));
  for (const list of placed.values()) list.sort((a, b) => a.position - b.position || a.rack.ci.displayName.localeCompare(b.rack.ci.displayName));
  return { rows, placed };
}

/** Rooms, racks and devices in world coordinates. Racks without a room share one slab named by the caller. */
export function buildFacilityModel(racks: ReadonlyArray<Rack>, unplacedLabel: string): FacilityModel {
  const byRoom = new Map<string, { name: string; racks: Rack[] }>();
  for (const rack of racks) {
    const id = rack.room?.id ?? UNPLACED_ROOM_ID;
    const name = rack.room?.displayName ?? unplacedLabel;
    const entry = byRoom.get(id) ?? { name, racks: [] };
    entry.racks.push(rack);
    byRoom.set(id, entry);
  }
  const roomIds = [...byRoom.keys()].sort((a, b) => (byRoom.get(a)?.name ?? '').localeCompare(byRoom.get(b)?.name ?? ''));

  const rooms: RoomSlab[] = [];
  const rackBoxes: RackBox[] = [];
  const devices: DeviceSlab[] = [];
  let maxHeightM = 0;
  // Rooms are tiled in a grid; each column is as wide as the widest room in it, each grid row as deep as its deepest room.
  const roomSizes = roomIds.map((id) => {
    const entry = byRoom.get(id);
    const { rows, placed } = placeInRoom(entry?.racks ?? []);
    const longest = Math.max(1, ...rows.map((row) => placed.get(row)?.length ?? 0));
    const width = longest * (TWIN.rackWidthM + TWIN.rackGapM) - TWIN.rackGapM + TWIN.roomPaddingM + TWIN.roomPaddingM;
    const depth = Math.max(1, rows.length) * (TWIN.rackDepthM + TWIN.rowGapM) - TWIN.rowGapM + TWIN.roomPaddingM + TWIN.roomPaddingM;
    return { id, rows, placed, width, depth };
  });
  const columnWidths: number[] = [];
  const rowDepths: number[] = [];
  roomSizes.forEach((room, index) => {
    const column = index % TWIN.roomsPerRow;
    const gridRow = Math.floor(index / TWIN.roomsPerRow);
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, room.width);
    rowDepths[gridRow] = Math.max(rowDepths[gridRow] ?? 0, room.depth);
  });
  const columnStarts = columnWidths.map((_, column) => columnWidths.slice(0, column).reduce((sum, w) => sum + w + TWIN.roomGapM, 0));
  const rowStarts = rowDepths.map((_, row) => rowDepths.slice(0, row).reduce((sum, d) => sum + d + TWIN.roomGapM, 0));

  roomSizes.forEach((room, index) => {
    const column = index % TWIN.roomsPerRow;
    const gridRow = Math.floor(index / TWIN.roomsPerRow);
    const originX = columnStarts[column] ?? 0;
    const originZ = rowStarts[gridRow] ?? 0;
    const entry = byRoom.get(room.id);
    const slab: RoomSlab = {
      id: room.id,
      name: entry?.name ?? unplacedLabel,
      center: [originX + room.width / GEOMETRY.halfDivisor, TWIN.roomSlabHeightM / GEOMETRY.halfDivisor, originZ + room.depth / GEOMETRY.halfDivisor],
      size: [room.width, TWIN.roomSlabHeightM, room.depth],
      rackCount: entry?.racks.length ?? 0,
      rows: room.rows,
    };
    rooms.push(slab);
    room.rows.forEach((row, rowIndex) => {
      const z = originZ + TWIN.roomPaddingM + rowIndex * (TWIN.rackDepthM + TWIN.rowGapM) + TWIN.rackDepthM / GEOMETRY.halfDivisor;
      (room.placed.get(row) ?? []).forEach((placedRack, rackIndex) => {
        const rack = placedRack.rack;
        const units = Math.max(rack.units, rack.devices.reduce((m, d) => Math.max(m, d.startUnit + d.heightUnits - 1), 0), 1);
        const heightM = units * TWIN.unitHeightM;
        const x = originX + TWIN.roomPaddingM + rackIndex * (TWIN.rackWidthM + TWIN.rackGapM) + TWIN.rackWidthM / GEOMETRY.halfDivisor;
        const loadPercent = loadPercentOf(rack);
        const box: RackBox = {
          id: rack.ci.id,
          name: rack.ci.displayName,
          ci: rack.ci,
          roomId: room.id,
          row,
          position: placedRack.position,
          units,
          occupiedUnits: rack.occupiedUnits,
          ratedWatts: rack.powerFeeds.reduce((sum, f) => sum + f.ratedWatts, 0),
          currentWatts: rack.powerFeeds.reduce((sum, f) => sum + f.currentWatts, 0),
          loadPercent,
          center: [x, TWIN.roomSlabHeightM + heightM / GEOMETRY.halfDivisor, z],
          size: [TWIN.rackWidthM, heightM, TWIN.rackDepthM],
          labelPosition: [x, TWIN.roomSlabHeightM + heightM + TWIN.labelOffsetM, z],
          color: rackColor(loadPercent, rack.powerFeeds.length > 0),
          devices: [],
          feeds: rack.powerFeeds,
        };
        for (const device of rack.devices) {
          const plateHeight = device.heightUnits * TWIN.unitHeightM;
          const y = TWIN.roomSlabHeightM + (device.startUnit - 1) * TWIN.unitHeightM + plateHeight / GEOMETRY.halfDivisor;
          const slabDevice: DeviceSlab = {
            id: device.ci.id,
            rackId: box.id,
            name: device.ci.displayName,
            ci: device.ci,
            layer: device.ci.layer,
            startUnit: device.startUnit,
            heightUnits: device.heightUnits,
            face: device.face,
            position: [x, y, z],
            size: [TWIN.rackWidthM - TWIN.deviceInsetM - TWIN.deviceInsetM, plateHeight * TWIN.deviceHeightShare, TWIN.rackDepthM - TWIN.deviceInsetM - TWIN.deviceInsetM],
            color: layerColor(device.ci.layer),
          };
          box.devices.push(slabDevice);
          devices.push(slabDevice);
        }
        rackBoxes.push(box);
        maxHeightM = Math.max(maxHeightM, heightM);
      });
    });
  });

  const maxX = Math.max(0, ...rooms.map((r) => r.center[0] + r.size[0] / GEOMETRY.halfDivisor));
  const maxZ = Math.max(0, ...rooms.map((r) => r.center[GEOMETRY.axisZ] + r.size[GEOMETRY.axisZ] / GEOMETRY.halfDivisor));
  return {
    rooms,
    racks: rackBoxes,
    devices,
    bounds: { minX: 0, maxX, minZ: 0, maxZ },
    maxHeightM,
    center: [maxX / GEOMETRY.halfDivisor, 0, maxZ / GEOMETRY.halfDivisor],
  };
}

export interface GraphNodeSphere {
  id: string;
  label: string;
  type: string;
  layer: CiLayer;
  depth: number;
  predicted: PredictedState;
  health: HealthState;
  position: Vec3;
  /** Above the sphere, where its label floats. */
  labelPosition: Vec3;
  radius: number;
  color: HexColor;
  isRoot: boolean;
}

export interface GraphEdgeLine {
  id: string;
  from: Vec3;
  to: Vec3;
  color: HexColor;
  onServicePath: boolean;
}

export interface LayerPlane {
  layer: CiLayer;
  /** Height of the plane, metres. */
  y: number;
  color: HexColor;
  nodeCount: number;
  /** Side of the square plane, metres: the node grid plus a margin, never below the base size. */
  sizeM: number;
}

export interface GraphModel {
  planes: LayerPlane[];
  nodes: GraphNodeSphere[];
  edges: GraphEdgeLine[];
  /** Centre of the graph in world space, where the camera looks when a focus is set. */
  center: Vec3;
}

/** Plane height of a layer: CI_LAYERS order from the ground up, so applications float highest. */
export function planeHeight(layer: CiLayer): number {
  return TWIN.planeStartHeightM + CI_LAYERS.indexOf(layer) * TWIN.planeGapM;
}

export function nodeRadius(depth: number): number {
  const share = Math.max(TWIN.nodeRadiusMinShare, 1 - depth * TWIN.nodeRadiusStep);
  return TWIN.nodeRadiusM * share;
}

/** Column and row of the n-th node on a square grid of `columns`, centred on the origin. */
export function gridOffset(index: number, columns: number): { dx: number; dz: number } {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const half = (columns - 1) / GEOMETRY.halfDivisor;
  return { dx: (column - half) * TWIN.nodeSpacingM, dz: (row - half) * TWIN.nodeSpacingM };
}

/**
 * The impact graph on the layer planes: every node sits on the plane of its layer, on a square grid centred over
 * `origin` with the root first (so it is near the centre), nearer hops before farther ones; edges join the points.
 * A grid per plane keeps 1,000 nodes of one layer inside a 30 m square instead of a line, which is what the 2D
 * lane layout would give.
 */
export function buildGraphModel(graph: ImpactGraph, rootId: string, origin: Vec3): GraphModel {
  const nodes: GraphNodeSphere[] = [];
  const byId = new Map<string, GraphNodeSphere>();
  const counts = new Map<CiLayer, number>();
  const byLayer = new Map<CiLayer, MapNode[]>();
  for (const node of graph.nodes) {
    const list = byLayer.get(node.layer) ?? [];
    list.push(node);
    byLayer.set(node.layer, list);
  }
  const placed = new Map<string, { dx: number; dz: number }>();
  const planeSize = new Map<CiLayer, number>();
  for (const [layer, list] of byLayer) {
    const ordered = [...list].sort((a, b) => (a.id === rootId ? -1 : b.id === rootId ? 1 : a.depth - b.depth || a.label.localeCompare(b.label)));
    const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
    ordered.forEach((node, index) => placed.set(node.id, gridOffset(index, columns)));
    planeSize.set(layer, Math.max(TWIN.planeSizeM, (columns - 1) * TWIN.nodeSpacingM + TWIN.planeMarginM + TWIN.planeMarginM));
  }
  for (const node of graph.nodes) {
    const offset = placed.get(node.id);
    if (offset === undefined) continue;
    const isRoot = node.id === rootId;
    const radius = isRoot ? TWIN.rootNodeRadiusM : nodeRadius(node.depth);
    const position: Vec3 = [origin[GEOMETRY.axisX] + offset.dx, origin[GEOMETRY.axisY] + planeHeight(node.layer), origin[GEOMETRY.axisZ] + offset.dz];
    const sphere: GraphNodeSphere = {
      id: node.id,
      label: node.label,
      type: node.type,
      layer: node.layer,
      depth: node.depth,
      predicted: node.predicted,
      health: node.health,
      position,
      labelPosition: [position[0], position[1] + radius + TWIN.labelOffsetM, position[GEOMETRY.axisZ]],
      radius,
      color: nodeColor(node),
      isRoot,
    };
    nodes.push(sphere);
    byId.set(node.id, sphere);
    counts.set(node.layer, (counts.get(node.layer) ?? 0) + 1);
  }
  const edges: GraphEdgeLine[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (from === undefined || to === undefined) continue;
    edges.push({ id: edge.id, from: from.position, to: to.position, color: predictedColor(edge.predicted), onServicePath: edge.onServicePath });
  }
  const planes: LayerPlane[] = CI_LAYERS.filter((layer) => (counts.get(layer) ?? 0) > 0).map((layer) => ({ layer, y: origin[GEOMETRY.axisY] + planeHeight(layer), color: layerColor(layer), nodeCount: counts.get(layer) ?? 0, sizeM: planeSize.get(layer) ?? TWIN.planeSizeM }));
  const centerY = planes.length === 0 ? origin[GEOMETRY.axisY] : planes.reduce((s, p) => s + p.y, 0) / planes.length;
  return { planes, nodes, edges, center: [origin[GEOMETRY.axisX], centerY, origin[GEOMETRY.axisZ]] };
}

/** A mutable copy of a vector for the renderer's tuple props. */
export function xyz(v: Vec3): [number, number, number] {
  const [x, y, z] = v;
  return [x, y, z];
}

/** Shortens a label for the scene. */
export function sceneLabel(name: string): string {
  return name.length > TWIN.labelMaxChars ? name.slice(0, TWIN.labelMaxChars - 1) + '…' : name;
}

/** Camera start: back and up from the centre by shares of the scene radius, so everything fits on first paint. */
export function cameraStart(center: Vec3, radius: number): Vec3 {
  const distance = Math.max(radius, 1) * TWIN.cameraStartRadiusShare;
  return [center[0] + distance, center[1] + distance * TWIN.cameraStartElevationShare, center[GEOMETRY.axisZ] + distance];
}

/** Radius of the sphere that holds the facility and the planes. */
export function sceneRadius(facility: FacilityModel, graph: GraphModel | null): number {
  const horizontal = Math.max(facility.bounds.maxX - facility.bounds.minX, facility.bounds.maxZ - facility.bounds.minZ) / GEOMETRY.halfDivisor;
  const planeHalf = graph === null ? 0 : Math.max(0, ...graph.planes.map((p) => p.sizeM)) / GEOMETRY.halfDivisor;
  const top = graph === null ? facility.maxHeightM : Math.max(...graph.planes.map((p) => p.y), facility.maxHeightM);
  return Math.max(horizontal, planeHalf, top, 1);
}

export type { MapNode };
