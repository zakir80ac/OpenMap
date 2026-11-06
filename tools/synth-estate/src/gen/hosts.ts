// REQ-QA-001 — physical hosts: Dell/HPE/Lenovo servers with serials, system UUIDs, BMCs on the
// OOB network, operating systems, dual power feeds, ToR cabling and base software installs.
import { HYPERVISOR_PREFIX, POOL, SOFTWARE, VENDORS, VLAN_ID, type OsDef, type SoftwareDef } from '../catalog.js';
import type { Attributes } from '@openmap/contracts';
import type { Slot } from '../estate.js';
import { cidr, RFC1918_TEN } from '../ip.js';
import type { Rng } from '../rng.js';
import { dateAt, isoAt, MS_PER_DAY } from '../time.js';
import { allocateIp, attachIp, ensureSoftware, fqdnOf, installPath, pad, type HostRec, type SiteWorld, type World } from '../world.js';
import { hostComponents } from './components.js';
import { allocateHostPort } from './network.js';

const BARE_METAL_PURPOSES = ['oracle', 'sql', 'hadoop', 'backup', 'batch', 'file', 'sas', 'build', 'gpu', 'hsm'] as const;
const CPU_MODELS = ['Intel Xeon Gold 6448Y', 'Intel Xeon Platinum 8468', 'AMD EPYC 9354', 'AMD EPYC 9454'] as const;
const NICS = ['eno1', 'eno2'] as const;
const WINDOWS_NICS = ['Ethernet', 'Ethernet 2'] as const;
const WARRANTY_YEARS_OPTIONS = [3, 5] as const;
const DAYS_PER_YEAR = 365;
const PURCHASE_AGE_DAYS_MAX = 2600;
const PURCHASE_AGE_DAYS_MIN = 30;
const PATCH_AGE_DAYS_MAX = 120;
const AGENT_PROBABILITY = 0.5;
const BIOS_VERSIONS = ['2.14.2', '1.9.1', 'U46 v2.16', 'KAE130U'] as const;

function ouiFor(manufacturer: string): readonly [number, number, number] {
  return VENDORS.find((v) => v.name === manufacturer)?.oui ?? [0x00, 0x1b, 0x54];
}

function osSubscription(os: OsDef): SoftwareDef | undefined {
  const byName: Record<string, string> = { Ubuntu: 'Ubuntu Pro', 'Red Hat Enterprise Linux': 'Enterprise Linux Server Subscription', 'Windows Server': 'Windows Server Datacenter', 'VMware ESXi': 'vSphere Enterprise Plus', 'Nutanix AHV': 'AOS Ultimate' };
  const wanted = byName[os.name];
  return SOFTWARE.find((s) => s.name === wanted);
}

function hostSlot(world: World, site: SiteWorld, os: OsDef, ordinal: number): Slot {
  const nodeId = site.def.nodeIds[ordinal % site.def.nodeIds.length] ?? site.nodeId;
  const family = os.collector;
  return world.b.slotFor(family + '|' + nodeId, {
    family,
    collectorId: family === 'wmi' ? 'wmi' : 'ssh-agentless',
    nodeId,
    siteCode: site.def.code,
    target: { kind: 'cidr', value: cidr(RFC1918_TEN, site.def.octetBase + POOL.servers, 0, 0, 16), label: site.def.code + ' server network' },
    evidenceKind: 'cli_output',
  });
}

function bmcSlot(world: World, site: SiteWorld, ordinal: number): Slot {
  const nodeId = site.def.nodeIds[ordinal % site.def.nodeIds.length] ?? site.nodeId;
  return world.b.slotFor('ipmi|' + nodeId, {
    family: 'ipmi_redfish',
    collectorId: 'ipmi-redfish',
    nodeId,
    siteCode: site.def.code,
    target: { kind: 'cidr', value: cidr(RFC1918_TEN, site.def.octetBase + POOL.oob, 0, 0, 16), label: site.def.code + ' out-of-band network' },
    evidenceKind: 'api_response',
  });
}

/** Adds a software_instance on a host or VM CI and links it to the catalogue entry. */
export function installSoftware(world: World, rng: Rng, slot: Slot, computeIdx: number, computeRef: string, def: SoftwareDef, family: OsDef['family'], siteCode: string): number {
  const { b } = world;
  const softwareIdx = ensureSoftware(world, def);
  const path = installPath(def.path, family);
  const idx = b.ci(
    slot,
    'software_instance',
    { hostRef: computeRef, softwareRef: b.ref(softwareIdx), installPath: path },
    def.name + ' ' + def.version + ' on ' + b.get(computeIdx).name,
    { vendor: def.vendor, name: def.name, version: def.version, installPath: path, installedAt: isoAt(-rng.int(10, 900) * MS_PER_DAY), category: def.category, running: true },
    siteCode,
    { tags: ['software'] },
  );
  b.rel(slot, 'installed_on', idx, computeIdx);
  b.rel(slot, 'member_of', idx, softwareIdx);
  return idx;
}

export function generateHosts(world: World, rng: Rng): void {
  const { b } = world;
  const agents = SOFTWARE.filter((s) => s.category === 'agent' && s.name !== 'VMware Tools' && s.name !== 'Backup and Replication' && s.name !== 'Zabbix Server');
  for (const site of world.sites) {
    if (site.def.hostShare <= 0) continue;
    const plans = world.hostPlans.filter((p) => p.site === site);
    const clusterMembers = new Map<number, number>();
    let bareMetalSeq = 0;
    plans.forEach((plan, ordinal) => {
      const rack = plan.rack;
      if (!rack) throw new Error('host without a rack');
      let hostname: string;
      if (plan.platform !== null && plan.clusterName !== null) {
        const k = (clusterMembers.get(plan.cluster) ?? 0) + 1;
        clusterMembers.set(plan.cluster, k);
        const clusterNo = plan.clusterName.slice(plan.clusterName.lastIndexOf('-c') + 2);
        hostname = HYPERVISOR_PREFIX[plan.platform] + '-' + site.short + '-c' + clusterNo + '-' + pad(k, 2);
      } else {
        bareMetalSeq++;
        hostname = 'srv-' + site.short + '-' + rng.pick(BARE_METAL_PURPOSES) + '-' + pad(bareMetalSeq, 4);
      }
      const fqdn = fqdnOf(hostname);
      const slot = hostSlot(world, site, plan.os, ordinal);
      const serial = plan.model.serialPrefix + rng.alnum(7);
      const systemUuid = rng.uuid();
      const primaryMac = rng.mac(ouiFor(plan.model.manufacturer));
      const alloc = allocateIp(world, site, 'servers');
      const purchaseAge = rng.int(PURCHASE_AGE_DAYS_MIN, PURCHASE_AGE_DAYS_MAX);
      const warrantyYears = rng.pick(WARRANTY_YEARS_OPTIONS);
      const warrantyEndOffset = -purchaseAge + warrantyYears * DAYS_PER_YEAR;
      const hostAttributes: Attributes = {
          hostname,
          fqdn,
          manufacturer: plan.model.manufacturer,
          model: plan.model.model,
          partNumber: plan.model.partNumber,
          serialNumber: serial,
          systemUuid,
          assetTag: 'SRV-' + rng.alnum(7),
          cpuSockets: plan.model.cpuSockets,
          cpuCores: plan.model.cpuSockets * plan.model.coresPerSocket,
          cpuModel: rng.pick(CPU_MODELS),
          memoryGb: plan.model.memoryGb,
          primaryMac,
          primaryIp: alloc.address,
          rack: rack.name,
          uPosition: plan.uPosition,
          heightU: plan.model.heightU,
          biosVersion: rng.pick(BIOS_VERSIONS),
          powerState: 'on',
          role: plan.platform === null ? 'bare_metal' : 'hypervisor',
          platform: plan.platform,
          osName: plan.os.name,
          osVersion: plan.os.version,
          purchaseDate: dateAt(-purchaseAge),
          warrantyEnd: dateAt(warrantyEndOffset),
          warrantyExpired: warrantyEndOffset < 0,
          warrantyProvider: plan.model.manufacturer,
          warrantyLevel: rng.chance(0.7) ? 'ProSupport Plus 4h' : 'Basic NBD',
          uptimeSeconds: rng.int(3600, 300 * 24 * 3600),
          site: site.def.code,
        };
      // ADR-037: the parts the collectors report, on a stream of their own (no other value moves).
      const components = hostComponents({ model: plan.model, cpuModel: String(hostAttributes['cpuModel']), serial, hypervisor: plan.platform !== null });
      const hostIdx = b.ci(
        slot,
        'host',
        { serialNumber: serial, systemUuid, fqdn, primaryMac },
        hostname,
        hostAttributes,
        site.def.code,
        { tags: ['hardware', plan.platform === null ? 'bare-metal' : 'hypervisor'], primary: true, components },
      );
      b.rel(slot, 'located_in', hostIdx, rack.idx, { uPosition: plan.uPosition, heightU: plan.model.heightU });
      b.rel(slot, 'powered_by', hostIdx, rack.pduA, { feed: 'A', psu: 1 });
      b.rel(slot, 'powered_by', hostIdx, rack.pduB, { feed: 'B', psu: 2 });
      const ipIdx = attachIp(world, slot, hostIdx, alloc, site.def.code, { interface: plan.os.family === 'windows' ? 'Ethernet' : 'bond0', macAddress: primaryMac });

      const rowIndex = site.rooms.flatMap((r) => r.rows).indexOf(rack.row);
      const prodVlan = VLAN_ID.prodBase + Math.max(0, rowIndex);
      const nics = plan.os.family === 'windows' ? WINDOWS_NICS : NICS;
      rack.tors.forEach((tor, n) => {
        const nic = nics[n] ?? nics[0];
        const port = allocateHostPort(world, rng, tor, hostname + ' ' + nic, prodVlan);
        b.rel(slot, 'cabled_to', hostIdx, port.idx, { hostNic: nic, media: '10GBASE-T', speedMbps: tor.model.speedMbps });
      });

      const osIdx = b.ci(
        slot,
        'operating_system',
        { hostRef: serial, family: plan.os.family, version: plan.os.version },
        plan.os.name + ' ' + plan.os.version + ' (' + hostname + ')',
        { name: plan.os.name, version: plan.os.version, family: plan.os.family, kernel: plan.os.kernel, architecture: 'x86_64', lastPatchedAt: dateAt(-rng.int(1, PATCH_AGE_DAYS_MAX)), timeZone: 'Asia/Riyadh', hostname },
        site.def.code,
        { tags: ['os'] },
      );
      b.rel(slot, 'runs_on', osIdx, hostIdx);

      const subscription = osSubscription(plan.os);
      if (subscription) installSoftware(world, rng, slot, hostIdx, serial, subscription, plan.os.family, site.def.code);
      if ((plan.os.family === 'linux' || plan.os.family === 'windows') && rng.chance(AGENT_PROBABILITY)) {
        const agent = rng.pick(agents.filter((a) => a.on.includes(plan.os.family)));
        installSoftware(world, rng, slot, hostIdx, serial, agent, plan.os.family, site.def.code);
      }

      const bslot = bmcSlot(world, site, ordinal);
      const bmcAlloc = allocateIp(world, site, 'oob');
      const bmcIdx = b.ci(
        bslot,
        'bmc',
        { managementIp: bmcAlloc.address, serialNumber: serial },
        hostname + '-bmc',
        { product: plan.model.bmcProduct, firmware: plan.model.bmcFirmware, manufacturer: plan.model.manufacturer, macAddress: rng.mac(ouiFor(plan.model.manufacturer)), protocol: 'redfish', redfishVersion: '1.17.0', powerState: 'On', healthRollup: rng.chance(0.96) ? 'OK' : 'Warning', psuCount: 2, fanCount: plan.model.heightU === 2 ? 8 : 6, inletTempC: rng.int(19, 27), hostSerial: serial },
        site.def.code,
        { tags: ['hardware', 'oob'], primary: true },
      );
      b.rel(bslot, 'manages', bmcIdx, hostIdx);
      attachIp(world, bslot, bmcIdx, bmcAlloc, site.def.code, { interface: 'bmc0', role: 'oob' });

      const rec: HostRec = { plan, idx: hostIdx, osIdx, hostname, fqdn, serial, ip: alloc.address, ipIdx, bmcIp: bmcAlloc.address, primaryMac, slot, hypervisor: null, role: null };
      site.hosts.push(rec);
      rack.hosts.push(rec);
    });
  }
}

/** Renames a host once an application claims it; identity fqdn and OS name follow. */
export function renameHost(world: World, host: HostRec, hostname: string, role: string): void {
  const ci = world.b.get(host.idx);
  const fqdn = fqdnOf(hostname);
  ci.name = hostname;
  ci.identity['fqdn'] = fqdn;
  ci.attributes['hostname'] = hostname;
  ci.attributes['fqdn'] = fqdn;
  ci.attributes['applicationRole'] = role;
  const os = world.b.get(host.osIdx);
  os.name = String(os.attributes['name']) + ' ' + String(os.attributes['version']) + ' (' + hostname + ')';
  os.attributes['hostname'] = hostname;
  host.hostname = hostname;
  host.fqdn = fqdn;
  host.role = role;
}
