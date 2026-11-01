// REQ-QA-001 — facilities: buildings, data halls, rows, 42U racks, A/B PDUs, power circuits, UPS
// and cooling. Hosts are packed bottom-up into racks here so the hardware generator knows each
// host's rack and U position; ToRs take the top two U.
import { COOLING_MODELS, PDU_MODELS, UPS_MODELS } from '../catalog.js';
import type { Rng } from '../rng.js';
import { dcimSlot, pad, type RackWorld, type RoomWorld, type RowWorld, type SiteWorld, type World } from '../world.js';

export const RACK_HEIGHT_U = 42;
/** Highest U a server may occupy; U37–U40 host patch panels and the management switch, U41–42 the ToRs. */
export const HOST_TOP_U = 36;
export const MGMT_SWITCH_U = 40;
export const TOR_A_U = 41;
export const TOR_B_U = 42;
const RACKS_PER_ROW = 20;
const ROWS_PER_ROOM = 8;
const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';
const COOLING_UNITS_PER_ROW_PAIR = 1;
const COOLING_MIN_PER_ROOM = 2;
const RACK_DESIGN_KW = 8;
const INPUT_VOLTAGE = 230;
const STORAGE_RACKS_BASE: Record<string, number> = { RYD: 3, JED: 2, 'DMM-COLO': 1 };

export function generateFacilities(world: World, rng: Rng): void {
  const { b } = world;
  for (const site of world.sites) {
    if (site.def.hostShare <= 0) continue;
    const slot = dcimSlot(world, site);
    site.buildingIdx = b.ci(
      slot,
      'building',
      { siteRef: site.def.code, name: site.def.building },
      site.def.code + ' ' + site.def.building,
      { floors: site.def.kind === 'office' ? 32 : 2, yearBuilt: site.def.kind === 'office' ? 2014 : 2019, address: site.def.address },
      site.def.code,
      { tags: ['facility'] },
    );
    b.rel(slot, 'located_in', site.buildingIdx, site.ciIdx);

    const plans = world.hostPlans.filter((p) => p.site === site);
    let rack: RackWorld | null = null;
    for (const plan of plans) {
      const height = plan.model.heightU;
      if (rack === null || rack.nextU + height - 1 > HOST_TOP_U) rack = newRack(world, site, rng);
      plan.rack = rack;
      plan.uPosition = rack.nextU;
      rack.nextU += height;
    }
    const storageRacks = site.def.kind === 'office' ? 0 : b.count(STORAGE_RACKS_BASE[site.def.code] ?? 1);
    for (let i = 0; i < storageRacks; i++) site.storageRacks.push(newRack(world, site, rng));
    for (const r of site.racks) {
      const rackCi = b.get(r.idx);
      rackCi.attributes['usedU'] = r.nextU - 1 + (RACK_HEIGHT_U - MGMT_SWITCH_U + 1);
    }
  }
}

function roomName(site: SiteWorld, roomNo: number): string {
  return site.def.kind === 'office' ? 'SR-B' + String(roomNo + 1) : 'DH' + pad(roomNo + 1, 2);
}

function newRoom(world: World, site: SiteWorld, rng: Rng): RoomWorld {
  const { b } = world;
  const slot = dcimSlot(world, site);
  const name = roomName(site, site.rooms.length);
  const full = site.def.code + '-' + name;
  const idx = b.ci(
    slot,
    'room',
    { buildingRef: site.def.building, name },
    full,
    { kind: site.def.kind === 'office' ? 'server_room' : 'data_hall', floor: site.def.kind === 'office' ? -1 : 1, floorAreaM2: site.def.kind === 'office' ? 120 : 1400, designKw: site.def.kind === 'office' ? 160 : 2400, hotAisleContainment: site.def.kind !== 'office' },
    site.def.code,
    { tags: ['facility'] },
  );
  b.rel(slot, 'located_in', idx, site.buildingIdx);

  const ups: number[] = [];
  const circuits: number[] = [];
  for (const feed of ['A', 'B'] as const) {
    const model = rng.pick(UPS_MODELS);
    const upsIdx = b.ci(
      slot,
      'ups',
      { serialNumber: model.serialPrefix + rng.alnum(8) },
      full + ' UPS-' + feed,
      { manufacturer: model.manufacturer, model: model.model, ratedKw: model.ratedKw, loadPercent: rng.int(28, 62), batteryRuntimeMinutes: rng.int(8, 15), feed, firmware: '7.1.' + String(rng.int(0, 9)) },
      site.def.code,
      { tags: ['power'] },
    );
    b.rel(slot, 'located_in', upsIdx, idx);
    ups.push(upsIdx);
    const circuitName = full + '-' + feed;
    const circuitIdx = b.ci(
      slot,
      'power_circuit',
      { siteRef: site.def.code, name: circuitName },
      circuitName,
      { feed, ratedAmps: 400, voltage: 400, phases: 3, breakerPanel: 'PP-' + name + '-' + feed },
      site.def.code,
      { tags: ['power'] },
    );
    b.rel(slot, 'powered_by', circuitIdx, upsIdx);
    circuits.push(circuitIdx);
  }
  const circuitA = circuits[0];
  const circuitB = circuits[1];
  if (circuitA === undefined || circuitB === undefined) throw new Error('room without A/B circuits');
  const room: RoomWorld = { idx, name, rows: [], circuitA, circuitB, cooling: [] };
  site.rooms.push(room);
  return room;
}

function ensureCooling(world: World, site: SiteWorld, room: RoomWorld, rng: Rng, needed: number): void {
  const { b } = world;
  const slot = dcimSlot(world, site);
  while (room.cooling.length < Math.max(COOLING_MIN_PER_ROOM, needed)) {
    const model = rng.pick(COOLING_MODELS);
    const n = room.cooling.length + 1;
    const idx = b.ci(
      slot,
      'cooling_unit',
      { serialNumber: model.serialPrefix + rng.alnum(8) },
      site.def.code + '-' + room.name + ' CRAH-' + pad(n, 2),
      { manufacturer: model.manufacturer, model: model.model, coolingKw: model.coolingKw, supplyTempC: rng.float(18, 21).toFixed(1), returnTempC: rng.float(27, 32).toFixed(1), fanSpeedPercent: rng.int(40, 85) },
      site.def.code,
      { tags: ['cooling'] },
    );
    b.rel(slot, 'located_in', idx, room.idx);
    room.cooling.push(idx);
  }
}

function newRow(world: World, site: SiteWorld, rng: Rng): RowWorld {
  const { b } = world;
  const slot = dcimSlot(world, site);
  let room = site.rooms[site.rooms.length - 1];
  if (!room || room.rows.length >= ROWS_PER_ROOM) room = newRoom(world, site, rng);
  const letter = ROW_LETTERS[room.rows.length] ?? 'Z';
  const name = letter;
  // roomRef is the room's tenant-wide name (site + room): rooms repeat short names like DH01 across sites and the
  // contract identifies rows and racks by (roomRef, name).
  const idx = b.ci(slot, 'row', { roomRef: site.def.code + '-' + room.name, name }, site.def.code + '-' + room.name + '-' + name, { position: room.rows.length + 1, rackCapacity: RACKS_PER_ROW, aisle: room.rows.length % 2 === 0 ? 'cold' : 'hot' }, site.def.code, { tags: ['facility'] });
  b.rel(slot, 'located_in', idx, room.idx);
  const row: RowWorld = { idx, name, room, racks: [], dists: [] };
  room.rows.push(row);
  ensureCooling(world, site, room, rng, Math.ceil(room.rows.length / 2) * COOLING_UNITS_PER_ROW_PAIR);
  return row;
}

export function newRack(world: World, site: SiteWorld, rng: Rng): RackWorld {
  const { b } = world;
  const slot = dcimSlot(world, site);
  let row = site.rooms[site.rooms.length - 1]?.rows.at(-1);
  if (!row || row.racks.length >= RACKS_PER_ROW) row = newRow(world, site, rng);
  const room = row.room;
  const name = site.def.code + '-' + room.name + '-' + row.name + '-' + pad(row.racks.length + 1, 2);
  const idx = b.ci(
    slot,
    'rack',
    { roomRef: site.def.code + '-' + room.name, name },
    name,
    { heightU: RACK_HEIGHT_U, widthMm: 600, depthMm: 1200, designKw: RACK_DESIGN_KW, usedU: 0, row: row.name, position: row.racks.length + 1, assetTag: 'RK-' + rng.alnum(6) },
    site.def.code,
    { tags: ['facility'] },
  );
  b.rel(slot, 'located_in', idx, row.idx);
  const coolingIdx = room.cooling[Math.floor((room.rows.length - 1) / 2) % Math.max(1, room.cooling.length)];
  if (coolingIdx !== undefined) b.rel(slot, 'cooled_by', idx, coolingIdx);

  const pdus: number[] = [];
  for (const feed of ['A', 'B'] as const) {
    const model = rng.pick(PDU_MODELS);
    const pduIdx = b.ci(
      slot,
      'pdu',
      { serialNumber: model.serialPrefix + rng.alnum(10) },
      name + ' PDU-' + feed,
      { manufacturer: model.manufacturer, model: model.model, outlets: model.outlets, ratedAmps: model.ratedAmps, inputVoltage: INPUT_VOLTAGE, feed, rack: name, measuredKw: Number(rng.float(0.8, 4.2).toFixed(2)), firmware: '6.9.' + String(rng.int(2, 8)), snmpSysName: name.toLowerCase() + '-pdu-' + feed.toLowerCase() },
      site.def.code,
      { tags: ['power'], primary: true },
    );
    b.rel(slot, 'located_in', pduIdx, idx);
    b.rel(slot, 'powered_by', pduIdx, feed === 'A' ? room.circuitA : room.circuitB);
    pdus.push(pduIdx);
  }
  const pduA = pdus[0];
  const pduB = pdus[1];
  if (pduA === undefined || pduB === undefined) throw new Error('rack without A/B PDUs');
  const rack: RackWorld = { idx, name, row, room, pduA, pduB, nextU: 1, tors: [], hosts: [] };
  row.racks.push(rack);
  site.racks.push(rack);
  return rack;
}
