// T-119 REQ-UI-029 — the twin model places racks by room, row and position at true proportions, colours them by
// load, stacks device plates at their units, lays an impact graph on the layer planes and frames the camera.
import { TWIN } from '@openmap/constants';
import type { CI_LAYERS } from '@openmap/contracts';
import { layerColor, stateColor } from '@openmap/ui';
import { describe, expect, it } from 'vitest';
import type { Rack } from './estate-queries';
import type { ImpactGraph } from './graph-layout';
import { buildFacilityModel, buildGraphModel, cameraStart, gridOffset, loadPercentOf, nodeRadius, planeHeight, rackColor, sceneLabel, sceneRadius } from './twin-model';

const ci = (id: string, displayName: string, layer: (typeof CI_LAYERS)[number], type: string, attributes: Record<string, unknown> = {}) => ({ id, name: id, displayName, code: id.toUpperCase(), type, layer, health: 'healthy' as const, attributes });

function rack(id: string, room: { id: string; displayName: string } | null, row: string, position: number, devices: Array<[string, number, number]>, watts: [number, number][] = [[7_360, 2_800]]): Rack {
  return {
    ci: ci(id, id.toUpperCase(), 'dc', 'rack', { row, position, heightU: 42 }),
    units: 42,
    occupiedUnits: devices.reduce((s, d) => s + d[2], 0),
    devices: devices.map(([name, startUnit, heightUnits]) => ({ ci: ci(name, name, 'hardware', 'host'), startUnit, heightUnits, face: 'front' })),
    powerFeeds: watts.map(([ratedWatts, currentWatts], i) => ({ ci: ci(id + '-pdu-' + String(i), id + ' PDU', 'dc', 'power_feed'), ratedWatts, currentWatts })),
    row: { id: row, displayName: row, attributes: {} },
    room: room === null ? null : { ...room, attributes: {} },
  };
}

const roomA = { id: 'room-a', displayName: 'DH01' };
const roomB = { id: 'room-b', displayName: 'DH02' };

describe('buildFacilityModel', () => {
  const model = buildFacilityModel(
    [
      rack('a-02', roomA, 'A', 2, [['srv-2', 1, 2]]),
      rack('a-01', roomA, 'A', 1, [['srv-1', 1, 1], ['tor-1', 42, 1]]),
      rack('b-01', roomA, 'B', 1, [], [[7_360, 7_000]]),
      rack('x-01', roomB, 'A', 1, [], []),
      rack('loose', null, '', 1, []),
    ],
    'Unplaced',
  );

  it('groups racks into rooms, orders rows and positions, and names the room of unplaced racks', () => {
    expect(model.rooms.map((r) => r.name)).toEqual(['DH01', 'DH02', 'Unplaced']);
    const dh01 = model.rooms[0];
    expect(dh01?.rows).toEqual(['A', 'B']);
    expect(dh01?.rackCount).toBe(3);
    const rowA = model.racks.filter((r) => r.roomId === 'room-a' && r.row === 'A').map((r) => r.id);
    expect(rowA).toEqual(['a-01', 'a-02']);
  });

  it('places racks at true proportions: 0.6 m apart plus the gap along x, rows along z, 42U tall', () => {
    const a1 = model.racks.find((r) => r.id === 'a-01');
    const a2 = model.racks.find((r) => r.id === 'a-02');
    const b1 = model.racks.find((r) => r.id === 'b-01');
    if (!a1 || !a2 || !b1) throw new Error('racks missing');
    expect(a2.center[0] - a1.center[0]).toBeCloseTo(TWIN.rackWidthM + TWIN.rackGapM);
    expect(a2.center[2]).toBeCloseTo(a1.center[2]);
    expect(b1.center[2] - a1.center[2]).toBeCloseTo(TWIN.rackDepthM + TWIN.rowGapM);
    expect(a1.size[1]).toBeCloseTo(42 * TWIN.unitHeightM);
    expect(model.maxHeightM).toBeCloseTo(42 * TWIN.unitHeightM);
  });

  it('stacks device plates at their units with the layer colour and keeps them inside the rack', () => {
    const a1 = model.racks.find((r) => r.id === 'a-01');
    const tor = a1?.devices.find((d) => d.id === 'tor-1');
    const srv = a1?.devices.find((d) => d.id === 'srv-1');
    if (!a1 || !tor || !srv) throw new Error('devices missing');
    expect(tor.position[1]).toBeGreaterThan(srv.position[1]);
    expect(tor.position[1]).toBeCloseTo(TWIN.roomSlabHeightM + 41 * TWIN.unitHeightM + TWIN.unitHeightM / 2);
    expect(tor.color).toBe(layerColor('hardware'));
    expect(tor.size[0]).toBeLessThan(a1.size[0]);
    expect(model.devices).toHaveLength(3);
  });

  it('colours racks by power load and marks racks without a feed as unknown', () => {
    expect(model.racks.find((r) => r.id === 'a-01')?.color).toBe(stateColor('healthy'));
    expect(model.racks.find((r) => r.id === 'b-01')?.color).toBe(stateColor('down'));
    expect(model.racks.find((r) => r.id === 'x-01')?.color).toBe(stateColor('unknown'));
    expect(rackColor(TWIN.loadWarnPercent, true)).toBe(stateColor('degraded'));
    expect(loadPercentOf(rack('z', null, '', 1, [], [[1_000, 250], [1_000, 250]]))).toBe(25);
  });

  it('tiles rooms in a grid without overlap and frames the whole facility', () => {
    const [dh01, dh02, unplaced] = model.rooms;
    if (!dh01 || !dh02 || !unplaced) throw new Error('rooms missing');
    expect(dh02.center[0] - dh02.size[0] / 2).toBeGreaterThanOrEqual(dh01.center[0] + dh01.size[0] / 2 + TWIN.roomGapM - Number.EPSILON);
    // Rooms in one grid row share their front edge; depths differ with the number of rows they hold.
    expect(unplaced.center[2] - unplaced.size[2] / 2).toBeCloseTo(dh01.center[2] - dh01.size[2] / 2);
    expect(model.bounds.maxX).toBeGreaterThan(unplaced.center[0]);
    expect(model.center[0]).toBeCloseTo(model.bounds.maxX / 2);
    const radius = sceneRadius(model, null);
    const start = cameraStart(model.center, radius);
    expect(start[1]).toBeGreaterThan(model.center[1]);
    expect(start[0]).toBeGreaterThan(model.center[0]);
  });
});

describe('buildGraphModel', () => {
  const graph: ImpactGraph = {
    nodes: [
      { id: 'db', label: 'ledger-db', type: 'database', layer: 'databases', health: 'healthy', depth: 0, predicted: 'down' },
      { id: 'app', label: 'ledger-app', type: 'application', layer: 'applications', health: 'healthy', depth: 1, predicted: 'degraded' },
      { id: 'host', label: 'host-1', type: 'host', layer: 'hardware', health: 'down', depth: 1, predicted: 'down' },
    ],
    edges: [
      { id: 'db→app', source: 'db', target: 'app', predicted: 'degraded', bridged: false, onServicePath: true },
      { id: 'host→db', source: 'host', target: 'db', predicted: 'down', bridged: false, onServicePath: false },
    ],
  };
  const model = buildGraphModel(graph, 'db', [10, 0, 10]);

  it('puts every node on the plane of its layer, in CI_LAYERS order from the ground up, centred over the origin', () => {
    const db = model.nodes.find((n) => n.id === 'db');
    const app = model.nodes.find((n) => n.id === 'app');
    const host = model.nodes.find((n) => n.id === 'host');
    if (!db || !app || !host) throw new Error('nodes missing');
    expect(db.position[1]).toBeCloseTo(planeHeight('databases'));
    expect(app.position[1]).toBeGreaterThan(db.position[1]);
    expect(host.position[1]).toBeLessThan(db.position[1]);
    // One node per plane sits at the plane's centre, over the origin.
    expect(db.position[0]).toBeCloseTo(10);
    expect(db.position[2]).toBeCloseTo(10);
    expect(app.position[0]).toBeCloseTo(10);
    expect(db.isRoot).toBe(true);
    expect(db.radius).toBe(TWIN.rootNodeRadiusM);
    expect(host.radius).toBeCloseTo(nodeRadius(1));
    expect(model.planes.map((p) => p.layer)).toEqual(['hardware', 'databases', 'applications']);
  });

  it('joins nodes with edges coloured by the predicted state and keeps the service path flag', () => {
    expect(model.edges).toHaveLength(2);
    const path = model.edges.find((e) => e.id === 'db→app');
    expect(path?.onServicePath).toBe(true);
    expect(path?.from).toEqual(model.nodes.find((n) => n.id === 'db')?.position);
    expect(model.center[1]).toBeGreaterThan(planeHeight('hardware'));
    expect(sceneLabel('a'.repeat(TWIN.labelMaxChars + 5))).toHaveLength(TWIN.labelMaxChars);
  });

  it('lays many nodes of one layer on a square grid with the root first and grows the plane to fit', () => {
    const many: ImpactGraph = {
      nodes: Array.from({ length: 100 }, (_, i) => ({ id: 'n' + String(i), label: 'node ' + String(i).padStart(3, '0'), type: 'host', layer: 'hardware' as const, health: 'healthy' as const, depth: i === 0 ? 0 : 1 + (i % 3), predicted: 'down' as const })),
      edges: [],
    };
    const grid = buildGraphModel(many, 'n0', [0, 0, 0]);
    const xs = grid.nodes.map((n) => n.position[0]);
    const zs = grid.nodes.map((n) => n.position[2]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(9 * TWIN.nodeSpacingM);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(9 * TWIN.nodeSpacingM);
    const root = grid.nodes.find((n) => n.isRoot);
    expect(root?.position[0]).toBeCloseTo(gridOffset(0, 10).dx);
    expect(grid.planes[0]?.sizeM).toBeGreaterThanOrEqual(TWIN.planeSizeM);
    expect(new Set(grid.nodes.map((n) => n.position.join(','))).size).toBe(100);
    expect(sceneRadius(buildFacilityModel([], 'x'), grid)).toBeGreaterThanOrEqual((grid.planes[0]?.sizeM ?? 0) / 2);
  });
});
