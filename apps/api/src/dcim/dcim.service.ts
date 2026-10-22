// REQ-DCIM-001 — DCIM use cases over rack, device and power_feed CIs: rack elevation from located_in /
// mounted_on relationships and power feeds from powered_by relationships.
import { Inject, Injectable } from '@nestjs/common';
import type { RelationshipType } from '@openmap/contracts';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, RelationshipRecord } from '../ci/ci.types.js';
import { numberAttribute, stringAttribute } from '../common/validation.js';

export const LOCATED_IN: RelationshipType = 'located_in';
export const MOUNTED_ON: RelationshipType = 'mounted_on';
export const POWERED_BY: RelationshipType = 'powered_by';

/** Attribute and relationship-attribute names that describe a rack elevation. */
export const RACK_ATTRIBUTES = { units: 'units', startUnit: 'startUnit', heightUnits: 'heightUnits', face: 'face', ratedWatts: 'ratedWatts', currentWatts: 'currentWatts' } as const;
export const DEFAULT_FACE = 'front';

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
}

@Injectable()
export class DcimService {
  constructor(@Inject(CI_REPOSITORY) private readonly cis: CiRepository) {}

  async racks(tenantId: string, roomId: string | null): Promise<RackView[]> {
    let racks = await this.cis.byType(tenantId, 'rack');
    if (roomId !== null) {
      const inRoom = await this.cis.relationshipsOfMany(tenantId, [roomId], [LOCATED_IN], 'upstream');
      const ids = new Set(inRoom.map((r) => r.fromCiId));
      racks = racks.filter((r) => ids.has(r.id));
    }
    if (racks.length === 0) return [];
    const rackIds = racks.map((r) => r.id);
    const [mounted, powered] = await Promise.all([
      this.cis.relationshipsOfMany(tenantId, rackIds, [LOCATED_IN, MOUNTED_ON], 'upstream'),
      this.cis.relationshipsOfMany(tenantId, rackIds, [POWERED_BY], 'downstream'),
    ]);
    const related = new Map((await this.cis.findByIds(tenantId, [...new Set([...mounted.map((r) => r.fromCiId), ...powered.map((r) => r.toCiId)])])).map((c) => [c.id, c]));
    return racks.map((rack) => toRack(rack, mounted.filter((r) => r.toCiId === rack.id), powered.filter((r) => r.fromCiId === rack.id), related));
  }
}

export function toRack(rack: CiRecord, mounted: readonly RelationshipRecord[], powered: readonly RelationshipRecord[], related: ReadonlyMap<string, CiRecord>): RackView {
  const devices: RackDeviceView[] = [];
  for (const rel of mounted) {
    const ci = related.get(rel.fromCiId);
    if (!ci || ci.type === 'power_feed') continue;
    devices.push({
      ci,
      startUnit: numberAttribute(rel.attributes, RACK_ATTRIBUTES.startUnit) ?? numberAttribute(ci.attributes, RACK_ATTRIBUTES.startUnit) ?? 0,
      heightUnits: numberAttribute(rel.attributes, RACK_ATTRIBUTES.heightUnits) ?? numberAttribute(ci.attributes, RACK_ATTRIBUTES.heightUnits) ?? 1,
      face: stringAttribute(rel.attributes, RACK_ATTRIBUTES.face) ?? stringAttribute(ci.attributes, RACK_ATTRIBUTES.face) ?? DEFAULT_FACE,
    });
  }
  devices.sort((a, b) => a.startUnit - b.startUnit || a.ci.name.localeCompare(b.ci.name));
  const powerFeeds: PowerFeedView[] = [];
  for (const rel of powered) {
    const ci = related.get(rel.toCiId);
    if (!ci || ci.type !== 'power_feed') continue;
    powerFeeds.push({ ci, ratedWatts: numberAttribute(ci.attributes, RACK_ATTRIBUTES.ratedWatts) ?? 0, currentWatts: numberAttribute(ci.attributes, RACK_ATTRIBUTES.currentWatts) ?? 0 });
  }
  return {
    ci: rack,
    units: numberAttribute(rack.attributes, RACK_ATTRIBUTES.units) ?? 0,
    occupiedUnits: devices.reduce((sum, d) => sum + d.heightUnits, 0),
    devices,
    powerFeeds,
  };
}
