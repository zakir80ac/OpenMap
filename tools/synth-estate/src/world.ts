// REQ-QA-001 — cross-generator records. Generators append to these so later stages (hosts need
// racks and ToR ports, VMs need hypervisors, flows need listening services) can reference CIs by
// index, and the IPAM helper keeps every address consistent with the subnet CIs it creates.
import { DOMAIN, POOL, VRF, type DbEngine, type HostModelDef, type HypervisorPlatform, type NetworkModelDef, type OsDef, type SiteDef, type SoftwareDef } from './catalog.js';
import type { EstateBuilder, Slot } from './estate.js';
import { cidr, poolAddress, RFC1918_TEN } from './ip.js';
import type { Rng } from './rng.js';

export interface RoomWorld {
  idx: number;
  name: string;
  rows: RowWorld[];
  circuitA: number;
  circuitB: number;
  cooling: number[];
}

export interface RowWorld {
  idx: number;
  name: string;
  room: RoomWorld;
  racks: RackWorld[];
  /** Distribution switch pair serving this row; filled by the network generator. */
  dists: DeviceRec[];
}

export interface RackWorld {
  idx: number;
  name: string;
  row: RowWorld;
  room: RoomWorld;
  pduA: number;
  pduB: number;
  /** Next free U from the bottom; ToRs sit at the top. */
  nextU: number;
  tors: DeviceRec[];
  hosts: HostRec[];
}

export interface HostPlan {
  site: SiteWorld;
  model: HostModelDef;
  /** Hypervisor platform when this host runs a hypervisor, else null (bare metal). */
  platform: HypervisorPlatform | null;
  /** Global cluster sequence for hypervisors, -1 for bare metal. */
  cluster: number;
  clusterName: string | null;
  os: OsDef;
  rack: RackWorld | null;
  uPosition: number;
}

export interface HostRec {
  plan: HostPlan;
  idx: number;
  osIdx: number;
  hostname: string;
  fqdn: string;
  serial: string;
  ip: string;
  ipIdx: number;
  bmcIp: string;
  primaryMac: string;
  slot: Slot;
  /** Filled by the virtualization generator for hypervisor hosts. */
  hypervisor: HypervisorRec | null;
  /** Application role once claimed by the application generator. */
  role: string | null;
}

export interface InterfaceRec {
  idx: number;
  name: string;
  ifIndex: number;
}

export interface DeviceRec {
  idx: number;
  site: SiteWorld;
  model: NetworkModelDef;
  sysName: string;
  mgmtIp: string;
  serial: string;
  rack: RackWorld | null;
  interfaces: InterfaceRec[];
  /** Index of the next host-facing port to hand out (1-based port number). */
  portCursor: number;
  /** VLAN CI index per VLAN id configured on this device. */
  vlans: Map<number, number>;
  slot: Slot;
}

export interface HypervisorRec {
  idx: number;
  host: HostRec;
  platform: HypervisorPlatform;
  clusterIdx: number;
  clusterName: string;
  moRef: string;
  vms: VmRec[];
}

export interface VmRec {
  idx: number;
  hypervisor: HypervisorRec;
  site: SiteWorld;
  name: string;
  fqdn: string;
  os: OsDef;
  ip: string;
  ipIdx: number;
  instanceUuid: string;
  slot: Slot;
  /** Workload role assigned by the application generator; null while unassigned. */
  role: string | null;
}

export interface ListeningRec {
  idx: number;
  /** Compute CI (vm or host) the service listens on. */
  computeIdx: number;
  site: SiteWorld;
  ip: string;
  port: number;
  protocol: 'tcp' | 'udp';
}

export interface ComponentRec {
  idx: number;
  name: string;
  tier: 'web' | 'api' | 'db' | 'auth' | 'infra';
  /** Compute CIs (vm, host or k8s_workload) that run this component. */
  computeIdx: number[];
  listeners: ListeningRec[];
  /** Kubernetes service CI when the component runs as a workload. */
  k8sServiceIdx: number | null;
}

export interface ApplicationRec {
  idx: number;
  name: string;
  slug: string;
  engine: DbEngine;
  containerised: boolean;
  components: ComponentRec[];
  site: SiteWorld;
  slot: Slot;
}

export interface K8sClusterRec {
  idx: number;
  name: string;
  clusterUid: string;
  site: SiteWorld;
  slot: Slot;
  namespaces: Map<string, number>;
  /** Worker nodes (VM CIs on-premises, cloud_resource CIs in cloud regions). */
  nodeIdx: number[];
  services: number;
}

export interface SiteWorld {
  def: SiteDef;
  /** Lower-case short code used in hostnames (ryd, jed, dmm, hq). */
  short: string;
  siteId: string;
  ciIdx: number;
  buildingIdx: number;
  supernetIdx: number;
  rooms: RoomWorld[];
  racks: RackWorld[];
  storageRacks: RackWorld[];
  networkRacks: RackWorld[];
  hosts: HostRec[];
  devices: DeviceRec[];
  cores: DeviceRec[];
  dists: DeviceRec[];
  firewalls: DeviceRec[];
  loadBalancers: DeviceRec[];
  hypervisors: HypervisorRec[];
  vms: VmRec[];
  storageArrays: number[];
  k8sClusters: K8sClusterRec[];
  /** Address allocation cursors per pool. */
  poolCursor: Map<string, number>;
  /** Subnet CI index per "cidr|vrf". */
  subnets: Map<string, number>;
  /** Slot that emits this site's subnets (core routing table walk). */
  ipamSlot: Slot | null;
  /** Primary node id of the site for collectors that run from inside the site. */
  nodeId: string;
  /** cloud_account CI for cloud regions, -1 elsewhere. */
  cloudAccountIdx: number;
}

export interface World {
  /** Kubernetes services still to be created by application generators after system services. */
  k8sServiceBudget: number;
  b: EstateBuilder;
  rng: Rng;
  sites: SiteWorld[];
  hostPlans: HostPlan[];
  listeners: ListeningRec[];
  applications: ApplicationRec[];
  authApp: ApplicationRec | null;
  infraListeners: Map<string, ListeningRec[]>;
  /** Software CI index per "vendor|name|version". */
  software: Map<string, number>;
  /** Branch subnet CI indices in branch order (for DHCP scopes and unknown devices). */
  branchSubnets: number[];
  branchCidrs: string[];
  /** Unknown devices claimed per branch so DHCP leases line up with the scan. */
  unknownByBranch: Map<number, number[]>;
  k8sClusters: K8sClusterRec[];
}

export type PoolName = keyof typeof POOL;

export interface IpAlloc {
  address: string;
  subnetIdx: number;
  subnetCidr: string;
  gateway: string;
  vrf: string;
}

export function siteOf(world: World, code: string): SiteWorld {
  const site = world.sites.find((s) => s.def.code === code);
  if (!site) throw new Error('unknown site ' + code);
  return site;
}

export function primarySite(world: World): SiteWorld {
  return siteOf(world, 'RYD');
}

export function ipamSlot(world: World, site: SiteWorld): Slot {
  if (site.ipamSlot) return site.ipamSlot;
  const slot = world.b.slotFor('ipam|' + site.def.code, {
    family: 'snmp',
    collectorId: 'snmp-v3',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'cidr', value: cidr(RFC1918_TEN, site.def.octetBase, 0, 0, 12), label: site.def.code + ' routing table' },
    evidenceKind: 'snmp_walk',
  });
  site.ipamSlot = slot;
  return slot;
}

/** DCIM sweep: smart PDUs, UPS and cooling expose rack and room placement over SNMP. */
export function dcimSlot(world: World, site: SiteWorld): Slot {
  return world.b.slotFor('dcim|' + site.def.code, {
    family: 'pdu',
    collectorId: 'pdu-dcim',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'cidr', value: cidr(RFC1918_TEN, site.def.octetBase + POOL.mgmt, 0, 0, 16), label: site.def.code + ' facilities' },
    evidenceKind: 'snmp_walk',
  });
}

/** Software asset management: software catalogue, licences, vendors and contracts. */
export function samSlot(world: World): Slot {
  const site = primarySite(world);
  return world.b.slotFor('sam', {
    family: 'agent',
    collectorId: 'agent-sam',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'host', value: 'sam-' + site.short + '-01.' + DOMAIN, label: 'software asset inventory' },
    evidenceKind: 'agent_report',
  });
}

export function softwareKey(def: Pick<SoftwareDef, 'vendor' | 'name' | 'version'>): string {
  return def.vendor + '|' + def.name + '|' + def.version;
}

export function ensureSoftware(world: World, def: SoftwareDef): number {
  const key = softwareKey(def);
  const existing = world.software.get(key);
  if (existing !== undefined) return existing;
  const slot = samSlot(world);
  const idx = world.b.ci(
    slot,
    'software',
    { vendor: def.vendor, name: def.name, version: def.version },
    def.vendor + ' ' + def.name + ' ' + def.version,
    { category: def.category, licensed: def.licensed, platforms: [...def.on], endOfSupport: null },
    primarySite(world).def.code,
    { tags: ['software', def.category] },
  );
  world.software.set(key, idx);
  return idx;
}

const POOL_VRF: Record<PoolName, string> = { mgmt: VRF.mgmt, oob: VRF.oob, servers: VRF.prod, vms: VRF.prod, storage: VRF.storage, k8s: VRF.prod, dmz: VRF.dmz, links: VRF.default };
const POOL_PURPOSE: Record<PoolName, string> = { mgmt: 'network management', oob: 'out-of-band BMC', servers: 'bare-metal servers', vms: 'virtual machines', storage: 'storage and vMotion', k8s: 'kubernetes nodes', dmz: 'dmz', links: 'point-to-point links' };

/** Allocates the next address in a site pool, creating the /24 subnet CI on first use. */
export function allocateIp(world: World, site: SiteWorld, pool: PoolName): IpAlloc {
  const cursor = site.poolCursor.get(pool) ?? 0;
  site.poolCursor.set(pool, cursor + 1);
  const placed = poolAddress(site.def.octetBase + POOL[pool], cursor);
  const vrf = POOL_VRF[pool];
  const subnetIdx = ensureSubnet(world, site, placed.subnetCidr, vrf, { purpose: POOL_PURPOSE[pool], pool, gateway: placed.gateway, prefixLength: 24, status: 'active' });
  return { address: placed.address, subnetIdx, subnetCidr: placed.subnetCidr, gateway: placed.gateway, vrf };
}

export function ensureSubnet(world: World, site: SiteWorld, subnetCidr: string, vrf: string, attributes: Record<string, string | number | boolean>): number {
  const key = subnetCidr + '|' + vrf;
  const existing = site.subnets.get(key);
  if (existing !== undefined) return existing;
  const slot = ipamSlot(world, site);
  const idx = world.b.ci(slot, 'subnet', { cidr: subnetCidr, vrfRef: vrf }, subnetCidr, { ...attributes, vrf, site: site.def.code }, site.def.code, { tags: ['ipam'] });
  world.b.rel(slot, 'contains', site.supernetIdx, idx);
  site.subnets.set(key, idx);
  return idx;
}

/** Creates an ip_address CI in the caller's slot with its uses_ip and in_subnet relationships. */
export function attachIp(world: World, slot: Slot, ownerIdx: number, alloc: IpAlloc, siteCode: string, extra: Record<string, string | number | boolean | null> = {}): number {
  const { b } = world;
  const idx = b.ci(slot, 'ip_address', { address: alloc.address, vrfRef: alloc.vrf }, alloc.address, { version: 4, vrf: alloc.vrf, subnet: alloc.subnetCidr, status: 'assigned', ...extra }, siteCode, { tags: ['ipam'] });
  b.rel(slot, 'uses_ip', ownerIdx, idx);
  b.rel(slot, 'in_subnet', idx, alloc.subnetIdx);
  return idx;
}

export function shortCode(def: SiteDef): string {
  const head = def.code.split('-')[0] ?? def.code;
  return head.toLowerCase();
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function fqdnOf(hostname: string): string {
  return hostname + '.' + DOMAIN;
}

/** Install path built from catalogue segments with the OS separator. */
export function installPath(segments: readonly string[], family: OsDef['family']): string {
  if (family === 'windows') return segments.join('\\');
  return '/' + segments.join('/');
}
