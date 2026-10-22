// REQ-QA-001 — cross-generator records. Generators append to these so later stages (hosts need
// racks and ToR ports, VMs need hypervisors, flows need listening services) can reference CIs by
// index, and the IPAM helper keeps every address consistent with the subnet CIs it creates.
import type { CiType } from '@openmap/contracts';
import { POOL, VRF, type DbEngine, type HostModelDef, type HypervisorPlatform, type NetworkModelDef, type OsDef, type SiteDef } from './catalog.js';
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
  /** Filled by the virtualization generator for hypervisor hosts. */
  hypervisor: HypervisorRec | null;
  /** Vendor CI index resolved by the commercial generator. */
  manufacturer: string;
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
  /** Index of the next host-facing port to hand out. */
  portCursor: number;
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
  /** Workload role assigned by the application generator; null while unassigned. */
  role: string | null;
  vcpus: number;
  memoryGb: number;
}

export interface ListeningRec {
  idx: number;
  /** Compute CI (vm or host) the service listens on. */
  computeIdx: number;
  ip: string;
  port: number;
  protocol: 'tcp' | 'udp';
}

export interface ComponentRec {
  idx: number;
  tier: 'web' | 'api' | 'db' | 'auth' | 'infra';
  /** Compute CIs (vm, host or k8s_workload) that run this component. */
  computeIdx: number[];
  listeners: ListeningRec[];
}

export interface ApplicationRec {
  idx: number;
  name: string;
  slug: string;
  engine: DbEngine;
  containerised: boolean;
  components: ComponentRec[];
  site: SiteWorld;
}

export interface K8sClusterRec {
  idx: number;
  name: string;
  clusterUid: string;
  site: SiteWorld;
  nodes: number[];
  slot: Slot;
  namespaces: Map<string, number>;
  /** Worker VMs used to place pods of workloads scheduled here. */
  workerVms: VmRec[];
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
  hosts: HostRec[];
  devices: DeviceRec[];
  cores: DeviceRec[];
  dists: DeviceRec[];
  accessPool: DeviceRec[];
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
}

export interface World {
  b: EstateBuilder;
  rng: Rng;
  sites: SiteWorld[];
  hostPlans: HostPlan[];
  /** Filled by generators as they run; read by later ones. */
  listeners: ListeningRec[];
  applications: ApplicationRec[];
  authApp: ApplicationRec | null;
  infraListeners: Map<string, ListeningRec[]>;
  softwareIdx: Map<string, number>;
  hostAgentSoftware: Map<number, number[]>;
  storageSlot: Slot | null;
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

export function shortCode(def: SiteDef): string {
  const head = def.code.split('-')[0] ?? def.code;
  return head.toLowerCase();
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function typeOf(world: World, idx: number): CiType {
  return world.b.get(idx).type;
}
