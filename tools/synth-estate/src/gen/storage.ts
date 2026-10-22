// REQ-QA-001 — storage: all-flash arrays in dedicated racks, LUNs presented to hypervisor
// clusters, NAS shares, dual FC fabrics with switches and per-host zones, and DR replication.
import { FC_SWITCH_MODELS, STORAGE_MODELS } from '../catalog.js';
import type { Slot } from '../estate.js';
import type { Rng } from '../rng.js';
import { allocateIp, attachIp, fqdnOf, pad, siteOf, type SiteWorld, type World } from '../world.js';

const LUNS_PER_ARRAY_BASE = 40;
const FC_SWITCHES_PER_FABRIC_BASE = 2;
const NAS_SHARES_PER_NETAPP = 2;
const FABRICS = ['A', 'B'] as const;
const LUN_SIZE_GB_OPTIONS = [512, 1024, 2048, 4096, 8192] as const;
const REPLICATION_RPO_MINUTES = 15;
const STORAGE_U = 1;

interface ArrayRec {
  idx: number;
  name: string;
  serial: string;
  site: SiteWorld;
  wwpn: string;
}

function storageSlot(world: World, site: SiteWorld): Slot {
  return world.b.slotFor('storage|' + site.nodeId, {
    family: 'storage',
    collectorId: 'storage-array',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'host', value: fqdnOf('storage-mgmt-' + site.short + '-01'), label: site.def.code + ' storage management' },
    evidenceKind: 'api_response',
  });
}

function fcSlot(world: World, site: SiteWorld, fabric: string): Slot {
  return world.b.slotFor('fc|' + site.nodeId + '|' + fabric, {
    family: 'fc_fabric',
    collectorId: 'fc-fabric',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'host', value: fqdnOf('fcsw-' + site.short + '-' + fabric.toLowerCase() + '-01'), label: site.def.code + ' fabric ' + fabric },
    evidenceKind: 'cli_output',
  });
}

function wwn(rng: Rng, prefix: string): string {
  const body = rng.hex(16 - prefix.length);
  const full = prefix + body;
  return (full.match(/.{2}/g) ?? []).join(':');
}

export function generateStorage(world: World, rng: Rng): void {
  const { b } = world;
  const arraysBySite = new Map<string, ArrayRec[]>();
  for (const site of world.sites) {
    if (site.storageRacks.length === 0) continue;
    const slot = storageSlot(world, site);
    const arrays: ArrayRec[] = [];
    site.storageRacks.forEach((rack, i) => {
      const model = STORAGE_MODELS[i % STORAGE_MODELS.length];
      if (!model) throw new Error('no storage models in catalogue');
      const serial = model.serialPrefix + rng.alnum(9);
      const vendorShort = model.manufacturer.split(' ')[0]?.toLowerCase() ?? 'array';
      const name = site.short + '-' + vendorShort + '-' + pad(i + 1, 2);
      const alloc = allocateIp(world, site, 'storage');
      const usableTb = Math.round(model.rawTb * 0.72);
      const idx = b.ci(
        slot,
        'storage_array',
        { serialNumber: serial },
        name,
        { manufacturer: model.manufacturer, model: model.model, rawTb: model.rawTb, usableTb, usedPercent: rng.int(35, 82), protocol: model.protocol, firmware: model.manufacturer === 'Pure Storage' ? 'Purity//FA 6.6.8' : model.manufacturer === 'NetApp' ? 'ONTAP 9.14.1P6' : 'PowerStoreOS 4.0.0', controllers: 2, managementIp: alloc.address, dataReductionRatio: Number(rng.float(2.1, 4.8).toFixed(1)), rack: rack.name },
        site.def.code,
        { tags: ['storage'], primary: true },
      );
      b.rel(slot, 'located_in', idx, rack.idx, { uPosition: STORAGE_U, heightU: model.heightU });
      b.rel(slot, 'powered_by', idx, rack.pduA, { feed: 'A' });
      b.rel(slot, 'powered_by', idx, rack.pduB, { feed: 'B' });
      attachIp(world, slot, idx, alloc, site.def.code, { interface: 'ct0.eth0', role: 'management' });
      rack.nextU += model.heightU;
      site.storageArrays.push(idx);
      const rec: ArrayRec = { idx, name, serial, site, wwpn: wwn(rng, '52') };
      arrays.push(rec);

      const clusters = [...new Set(site.hypervisors.map((h) => h.clusterName))];
      const lunCount = b.count(LUNS_PER_ARRAY_BASE);
      for (let l = 0; l < lunCount; l++) {
        const lunWwn = '6' + rng.hex(31);
        const clusterName = clusters[l % Math.max(1, clusters.length)];
        const sizeGb = rng.pick(LUN_SIZE_GB_OPTIONS);
        const lunIdx = b.ci(
          slot,
          'lun',
          { arrayRef: serial, wwn: lunWwn },
          name + '-lun-' + pad(l + 1, 3),
          { wwn: lunWwn, sizeGb, usedGb: Math.round(sizeGb * rng.float(0.2, 0.9)), thinProvisioned: true, tier: 'flash', hostGroup: clusterName ?? 'unassigned', lunId: l + 1, array: name },
          site.def.code,
          { tags: ['storage'] },
        );
        b.rel(slot, 'contains', idx, lunIdx);
        if (clusterName !== undefined) {
          for (const hyp of site.hypervisors) {
            if (hyp.clusterName !== clusterName) continue;
            b.rel(slot, 'presented_to', lunIdx, hyp.host.idx, { lunId: l + 1, protocol: model.protocol });
          }
        }
      }
      if (model.manufacturer === 'NetApp') {
        for (let s = 0; s < NAS_SHARES_PER_NETAPP; s++) {
          const volume = s === 0 ? 'users' : 'shared';
          const path = '/vol/' + volume;
          const shareIdx = b.ci(slot, 'nas_share', { arrayRef: serial, protocol: 'nfs', path }, name + ':' + path, { protocol: 'nfs', path, sizeGb: 20_480, usedPercent: rng.int(30, 75), exportPolicy: 'bank-servers', array: name }, site.def.code, { tags: ['storage'] });
          b.rel(slot, 'hosted_on', shareIdx, idx);
        }
      }
    });
    arraysBySite.set(site.def.code, arrays);

    FABRICS.forEach((fabric, f) => {
      const fslot = fcSlot(world, site, fabric);
      const fabricWwn = wwn(rng, '10');
      const fabricName = site.short + '-fab-' + fabric.toLowerCase();
      const switchCount = b.count(FC_SWITCHES_PER_FABRIC_BASE);
      const fabricIdx = b.ci(fslot, 'fc_fabric', { fabricWwn }, fabricName, { fabricWwn, name: fabricName, switchCount, zoneCount: site.hypervisors.length, zoningMode: 'peer', site: site.def.code }, site.def.code, { tags: ['storage', 'fc'] });
      for (let s = 0; s < switchCount; s++) {
        const model = FC_SWITCH_MODELS[f % FC_SWITCH_MODELS.length];
        if (!model) throw new Error('no FC switch models in catalogue');
        const wwnn = wwn(rng, '10');
        const serial = model.serialPrefix + rng.alnum(8);
        const rack = site.storageRacks[s % site.storageRacks.length];
        const swName = 'fcsw-' + site.short + '-' + fabric.toLowerCase() + '-' + pad(s + 1, 2);
        const swIdx = b.ci(fslot, 'fc_switch', { wwnn, serialNumber: serial }, swName, { manufacturer: model.manufacturer, model: model.model, ports: model.ports, firmware: model.fos, domainId: s + 1, principal: s === 0, fabric: fabricName, wwnn }, site.def.code, { tags: ['storage', 'fc'], primary: true });
        b.rel(fslot, 'member_of', swIdx, fabricIdx);
        if (rack) {
          b.rel(fslot, 'located_in', swIdx, rack.idx, { uPosition: rack.nextU, heightU: 1 });
          rack.nextU += 1;
          b.rel(fslot, 'powered_by', swIdx, rack.pduA, { feed: 'A' });
          b.rel(fslot, 'powered_by', swIdx, rack.pduB, { feed: 'B' });
        }
      }
      site.hypervisors.forEach((hyp, h) => {
        const arr = arrays[h % Math.max(1, arrays.length)];
        if (!arr) return;
        const zoneName = 'z_' + hyp.host.hostname.replace(/-/g, '_') + '_' + arr.name.replace(/-/g, '_');
        const hostWwpn = wwn(rng, '21');
        const zoneIdx = b.ci(fslot, 'fc_zone', { fabricRef: fabricWwn, name: zoneName }, zoneName, { members: [hostWwpn, arr.wwpn], fabric: fabricName, host: hyp.host.hostname, array: arr.name }, site.def.code, { tags: ['storage', 'fc'] });
        b.rel(fslot, 'member_of', zoneIdx, fabricIdx);
        b.rel(fslot, 'zoned_with', hyp.host.idx, arr.idx, { fabric, zone: zoneName, hostWwpn });
      });
    });
  }

  const primary = arraysBySite.get('RYD') ?? [];
  const dr = arraysBySite.get('JED') ?? [];
  if (primary.length > 0 && dr.length > 0) {
    const slot = storageSlot(world, siteOf(world, 'RYD'));
    primary.forEach((arr, i) => {
      const target = dr[i % dr.length];
      if (target) b.rel(slot, 'replicates_to', arr.idx, target.idx, { mode: 'async', rpoMinutes: REPLICATION_RPO_MINUTES, transport: 'fc' });
    });
  }
}
