// REQ-DCIM-001 REQ-DCIM-003 — DCIM use cases over rack, row, room, PDU and power-feed CIs: rack elevation from located_in /
// mounted_on relationships (position and height on the relationship, as the collectors and the synthetic estate
// emit them), power from PDUs located in the rack or power feeds the rack is powered by, and the rack's row and room.
// Attribute names come from the contract's DCIM_ATTRIBUTES so collectors, the estate and the API agree.
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { POWER, RECONCILIATION } from '@openmap/constants';
import { DCIM_ATTRIBUTES, type RelationshipType } from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import { checksumOf } from '../ci/checksum.js';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, RelationshipRecord } from '../ci/ci.types.js';
import { nowIso } from '../common/time.js';
import { numberAttribute, stringAttribute } from '../common/validation.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OutboxService } from '../outbox/outbox.service.js';

export const LOCATED_IN: RelationshipType = 'located_in';
export const MOUNTED_ON: RelationshipType = 'mounted_on';
export const POWERED_BY: RelationshipType = 'powered_by';
export const DEFAULT_FACE = 'front';

/** CI types that supply power to a rack rather than occupy its units. */
const POWER_TYPES: ReadonlySet<string> = new Set(['pdu', 'power_feed', 'power_circuit', 'ups']);

export interface RackDeviceView {
  ci: CiRecord;
  startUnit: number;
  heightUnits: number;
  face: string;
}

export interface PowerFeedView {
  ci: CiRecord;
  ratedWatts: number;
  currentWatts: number;
}

export interface RackView {
  ci: CiRecord;
  units: number;
  occupiedUnits: number;
  devices: RackDeviceView[];
  powerFeeds: PowerFeedView[];
  row: CiRecord | null;
  room: CiRecord | null;
}

/** First attribute of the list present on `attributes`, as a number. */
export function firstNumber(attributes: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = numberAttribute(attributes, name);
    if (value !== null) return value;
  }
  return null;
}

function firstString(attributes: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = stringAttribute(attributes, name);
    if (value !== null) return value;
  }
  return null;
}

/** Rated and measured watts of a PDU or feed from whichever of watts, amps × volts or kW the collector reported. */
export function powerOf(ci: CiRecord): { ratedWatts: number; currentWatts: number } {
  const ratedWatts = firstNumber(ci.attributes, DCIM_ATTRIBUTES.ratedWatts);
  const ratedAmps = firstNumber(ci.attributes, DCIM_ATTRIBUTES.ratedAmps);
  const volts = firstNumber(ci.attributes, DCIM_ATTRIBUTES.inputVoltage) ?? POWER.defaultInputVoltage;
  const currentWatts = firstNumber(ci.attributes, DCIM_ATTRIBUTES.currentWatts);
  const measuredKw = firstNumber(ci.attributes, DCIM_ATTRIBUTES.measuredKw);
  return {
    ratedWatts: Math.round(ratedWatts ?? (ratedAmps === null ? 0 : ratedAmps * volts)),
    currentWatts: Math.round(currentWatts ?? (measuredKw === null ? 0 : measuredKw * POWER.wattsPerKilowatt)),
  };
}

/** Rack attributes the floor plan (REQ-DCIM-003) reads and a move writes: the row's name and the slot along it. */
export const RACK_ROW_ATTRIBUTE = 'row';
export const RACK_POSITION_ATTRIBUTE = 'position';
/** Row attribute: how many rack slots the row has. */
export const ROW_CAPACITY_ATTRIBUTE = 'rackCapacity';

@Injectable()
export class DcimService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
  ) {}

  /** The room a rack or row sits in: itself `located_in` the room, or in a row that is. */
  private async roomOf(tenantId: string, ciId: string): Promise<CiRecord | null> {
    const [up] = await this.cis.relationshipsOfMany(tenantId, [ciId], [LOCATED_IN], 'downstream');
    if (up === undefined) return null;
    const [container] = await this.cis.findByIds(tenantId, [up.toCiId]);
    if (container === undefined) return null;
    if (container.type === 'room') return container;
    return container.type === 'row' ? this.roomOf(tenantId, container.id) : null;
  }

  /**
   * REQ-DCIM-003 — moves a rack to a slot of a row in its own room (a rack's identity is its room and name, so it never
   * leaves the room). The slot must be within the row's capacity, when the row states one, and free. The rack's row and
   * position attributes change and its `located_in` moves to the row, through the outbox with an audit action.
   */
  async placeRack(tenantId: string, actor: string, rackId: string, rowId: string, position: number): Promise<RackView> {
    const found = await this.cis.findByIds(tenantId, [rackId, rowId]);
    const rack = found.find((c) => c.id === rackId);
    const row = found.find((c) => c.id === rowId);
    if (rack === undefined || rack.type !== 'rack' || rack.validTo !== null) throw new NotFoundException('rack ' + rackId + ' not found');
    if (row === undefined || row.type !== 'row' || row.validTo !== null) throw new NotFoundException('row ' + rowId + ' not found');
    return withSpan(TRACER_NAME, 'dcim.rack.place', { 'openmap.tenant': tenantId }, async () => {
      const [rackRoom, rowRoom] = await Promise.all([this.roomOf(tenantId, rack.id), this.roomOf(tenantId, row.id)]);
      if (rowRoom === null || rackRoom?.id !== rowRoom.id) throw new BadRequestException('a rack moves only within its room');
      const capacity = numberAttribute(row.attributes, ROW_CAPACITY_ATTRIBUTE);
      if (capacity !== null && position > capacity) throw new BadRequestException(row.name + ' has ' + String(capacity) + ' slots');
      const inRow = await this.cis.relationshipsOfMany(tenantId, [row.id], [LOCATED_IN], 'upstream');
      const neighbours = await this.cis.findByIds(tenantId, inRow.map((r) => r.fromCiId).filter((id) => id !== rack.id));
      const taken = neighbours.find((n) => n.type === 'rack' && n.validTo === null && numberAttribute(n.attributes, RACK_POSITION_ATTRIBUTE) === position);
      if (taken !== undefined) throw new ConflictException(row.name + ' slot ' + String(position) + ' holds ' + taken.name);
      const rowName = stringAttribute(row.identity, 'name') ?? row.name;
      await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
        const attributes = { ...rack.attributes, [RACK_ROW_ATTRIBUTE]: rowName, [RACK_POSITION_ATTRIBUTE]: position };
        const ci = await this.cis.updateAttributes(tx, tenantId, rack.id, attributes, checksumOf(rack.type, rack.identity, attributes));
        await emit({ type: 'openmap.ci.updated', subject: ci.id, data: { ci, ciId: ci.id, changed: [RACK_ROW_ATTRIBUTE, RACK_POSITION_ATTRIBUTE], attributes: ci.attributes, checksum: ci.checksum, by: actor } });
        const placed = await this.cis.relationshipsOfMany(tenantId, [rack.id], [LOCATED_IN], 'downstream');
        if (!placed.some((r) => r.toCiId === row.id)) {
          const at = nowIso();
          for (const rel of placed) {
            const retired = await this.cis.retireRelationship(tx, tenantId, rel.id, at);
            await emit({ type: 'openmap.relationship.retired', subject: retired.id, data: { relationshipId: retired.id, validTo: retired.validTo, by: actor } });
          }
          const rel = await this.cis.createRelationship(tx, tenantId, { type: LOCATED_IN, fromCiId: rack.id, toCiId: row.id, attributes: {}, runId: randomUUID(), confidence: RECONCILIATION.userLabelConfidence });
          await emit({ type: 'openmap.relationship.created', subject: rel.id, data: { relationship: rel, by: actor } });
        }
        await emit({ type: 'openmap.audit.action', subject: rack.id, data: { action: 'dcim.rack.placed', rack: rack.name, row: rowName, position, by: actor } });
      });
      this.metrics.rackMoves.inc();
      const view = (await this.racks(tenantId, null)).find((v) => v.ci.id === rack.id);
      if (!view) throw new NotFoundException('rack ' + rackId + ' not found');
      return view;
    });
  }

  async racks(tenantId: string, roomId: string | null): Promise<RackView[]> {
    const racks = await this.cis.byType(tenantId, 'rack');
    if (racks.length === 0) return [];
    const rackIds = racks.map((r) => r.id);
    const [placed, mounted, powered] = await Promise.all([
      this.cis.relationshipsOfMany(tenantId, rackIds, [LOCATED_IN], 'downstream'),
      this.cis.relationshipsOfMany(tenantId, rackIds, [LOCATED_IN, MOUNTED_ON], 'upstream'),
      this.cis.relationshipsOfMany(tenantId, rackIds, [POWERED_BY], 'downstream'),
    ]);
    // rack → row (or room) → room: one hop up for racks placed in rows.
    const containerIds = [...new Set(placed.map((r) => r.toCiId))];
    const rowsPlaced = containerIds.length ? await this.cis.relationshipsOfMany(tenantId, containerIds, [LOCATED_IN], 'downstream') : [];
    const related = new Map(
      (await this.cis.findByIds(tenantId, [...new Set([...mounted.map((r) => r.fromCiId), ...powered.map((r) => r.toCiId), ...containerIds, ...rowsPlaced.map((r) => r.toCiId)])])).map((c) => [c.id, c]),
    );
    const views = racks.map((rack) => {
      const container = placed.find((r) => r.fromCiId === rack.id);
      const containerCi = container ? (related.get(container.toCiId) ?? null) : null;
      const row = containerCi?.type === 'row' ? containerCi : null;
      let room = containerCi?.type === 'room' ? containerCi : null;
      if (row !== null) {
        const up = rowsPlaced.find((r) => r.fromCiId === row.id);
        const upCi = up ? (related.get(up.toCiId) ?? null) : null;
        if (upCi?.type === 'room') room = upCi;
      }
      return toRack(rack, mounted.filter((r) => r.toCiId === rack.id), powered.filter((r) => r.fromCiId === rack.id), related, row, room);
    });
    return roomId === null ? views : views.filter((v) => v.room?.id === roomId || v.row?.id === roomId);
  }
}

export function toRack(rack: CiRecord, mounted: readonly RelationshipRecord[], powered: readonly RelationshipRecord[], related: ReadonlyMap<string, CiRecord>, row: CiRecord | null = null, room: CiRecord | null = null): RackView {
  const devices: RackDeviceView[] = [];
  const powerFeeds: PowerFeedView[] = [];
  for (const rel of mounted) {
    const ci = related.get(rel.fromCiId);
    if (!ci) continue;
    if (POWER_TYPES.has(ci.type)) {
      powerFeeds.push({ ci, ...powerOf(ci) });
      continue;
    }
    devices.push({
      ci,
      startUnit: firstNumber(rel.attributes, DCIM_ATTRIBUTES.position) ?? firstNumber(ci.attributes, DCIM_ATTRIBUTES.position) ?? 0,
      heightUnits: firstNumber(rel.attributes, DCIM_ATTRIBUTES.height) ?? firstNumber(ci.attributes, DCIM_ATTRIBUTES.height) ?? 1,
      face: firstString(rel.attributes, DCIM_ATTRIBUTES.face) ?? firstString(ci.attributes, DCIM_ATTRIBUTES.face) ?? DEFAULT_FACE,
    });
  }
  devices.sort((a, b) => a.startUnit - b.startUnit || a.ci.name.localeCompare(b.ci.name));
  for (const rel of powered) {
    const ci = related.get(rel.toCiId);
    if (!ci || !POWER_TYPES.has(ci.type) || powerFeeds.some((f) => f.ci.id === ci.id)) continue;
    powerFeeds.push({ ci, ...powerOf(ci) });
  }
  powerFeeds.sort((a, b) => a.ci.name.localeCompare(b.ci.name));
  return {
    ci: rack,
    units: firstNumber(rack.attributes, DCIM_ATTRIBUTES.rackUnits) ?? 0,
    occupiedUnits: devices.reduce((sum, d) => sum + d.heightUnits, 0),
    devices,
    powerFeeds,
    row,
    room,
  };
}
