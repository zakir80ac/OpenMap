// REQ-QA-001 — network: cores, distribution pairs per row, ToR access switches per rack,
// management switches, firewalls, load balancers, branch routers and switches, HQ campus access.
// Interfaces, VLANs, VRFs, routed /31 links and management addresses are consistent with IPAM.
import { SYNTH_ESTATE } from '@openmap/constants';
import {
  DOMAIN,
  INTERFACES_EMITTED,
  NETWORK_MODELS,
  POOL,
  UPLINKS_PER_ACCESS,
  VENDORS,
  VLAN_ID,
  VRF,
  type NetworkModelDef,
} from '../catalog.js';
import type { Slot } from '../estate.js';
import { cidr, ip4, linkPair, OCTET_MAX, RFC1918_TEN } from '../ip.js';
import { Rng } from '../rng.js';
import { dateAt } from '../time.js';
import {
  allocateIp,
  attachIp,
  ensureSubnet,
  identityMac,
  pad,
  type DeviceRec,
  type InterfaceRec,
  type IpAlloc,
  type RackWorld,
  type RowWorld,
  type SiteWorld,
  type World,
} from '../world.js';
import { MGMT_SWITCH_U, newRack, TOR_A_U, TOR_B_U, HOST_TOP_U } from './facilities.js';

const CORE_BASE: Record<string, number> = { RYD: 4, JED: 4, 'DMM-COLO': 2, HQ: 2 };
const FIREWALL_BASE: Record<string, number> = { RYD: 4, JED: 4, 'DMM-COLO': 2, HQ: 2 };
const LB_BASE: Record<string, number> = { RYD: 4, JED: 4, 'DMM-COLO': 2, HQ: 0 };
const MIN_PAIR = 2;
const DISTS_PER_ROW = 2;
const DIST_DOWNLINK_PORTS = 46;
const DIST_UPLINK_PORTS = [47, 48] as const;
const ACCESS_UPLINK_PORT_BASE = 49;
const ACCESS_HOST_PORTS = 48;
const CORE_PEER_PORTS = [23, 24] as const;
const FIREWALL_RULES_PER_DEVICE = 8;
const HQ_CAMPUS_ACCESS_BASE = 40;
const HQ_FLOORS = 32;
const BRANCH_BASE_COUNT = 212;
const BRANCH_SWITCH_UPLINK_PORT = 25;
const BRANCH_ROUTER_LAN_PORT = 1;
const BRANCH_ROUTER_WAN_PORT = 0;
const BRANCH_ROUTER_HOST = 1;
const BRANCH_SWITCH_HOST = 2;
const BRANCH_VLANS = [10, 20, 30] as const;
const BRANCH_VLAN_NAMES: Record<number, string> = { 10: 'DATA', 20: 'VOICE', 30: 'ATM' };
const HQ_DATA_VLAN_BASE = 1000;
const HQ_VOICE_VLAN_BASE = 2000;
const MTU_JUMBO = 9216;
const MTU_DEFAULT = 1500;
const UPTIME_MAX_SECONDS = 400 * 24 * 3600;
const WARRANTY_YEARS = 5;
const DAYS_PER_YEAR = 365;
/**
 * Child CIs of a network device (interfaces, VLANs, VRFs, firewall rules) point at it with the key kind and value, the
 * way the SNMP collector does (apps/collectors/internal/snmp/emit.go deviceRef): "serial:<serial>" when the device
 * reports one. Bare serials would make every SNMP sweep add a second copy of each interface instead of updating it.
 */
const DEVICE_REF_SERIAL = 'serial:';

/** Learned MACs kept per port, the SNMP collector's cap (maxLearnedMacs in apps/collectors/internal/snmp). */
const LEARNED_MACS_KEPT = 64;

export function networkDeviceRef(serial: string): string {
  return DEVICE_REF_SERIAL + serial;
}
const PURCHASE_AGE_DAYS_MAX = 2400;

function modelFor(role: NetworkModelDef['role'], rng: Rng): NetworkModelDef {
  const candidates = NETWORK_MODELS.filter((m) => m.role === role);
  return rng.pick(candidates);
}

function ouiFor(manufacturer: string): readonly [number, number, number] {
  return VENDORS.find((v) => v.name === manufacturer)?.oui ?? [0x00, 0x1b, 0x54];
}

function snmpSlot(world: World, site: SiteWorld): Slot {
  const nodeId = site.def.nodeIds[site.devices.length % site.def.nodeIds.length] ?? site.nodeId;
  return world.b.slotFor('snmp|' + nodeId, {
    family: 'snmp',
    collectorId: 'snmp-v3',
    nodeId,
    siteCode: site.def.code,
    target: {
      kind: 'cidr',
      value: cidr(RFC1918_TEN, site.def.octetBase + POOL.mgmt, 0, 0, 16),
      label: site.def.code + ' management network',
    },
    evidenceKind: 'snmp_walk',
  });
}

interface DeviceOptions {
  rack: RackWorld | null;
  uPosition: number | null;
  locatedIn: number;
  vlanIds: readonly number[];
  vlanNames?: Record<number, string>;
  vrfs: readonly string[];
  ipOverride?: IpAlloc;
  /** Ports materialised immediately (1..n); access switches add host ports lazily. */
  interfaceCount: number;
}

export function addDevice(
  world: World,
  rng: Rng,
  site: SiteWorld,
  model: NetworkModelDef,
  sysName: string,
  options: DeviceOptions,
): DeviceRec {
  const { b } = world;
  const slot = snmpSlot(world, site);
  const serial = model.serialPrefix + rng.alnum(8);
  const chassisId = identityMac(world, rng, ouiFor(model.manufacturer));
  const alloc = options.ipOverride ?? allocateIp(world, site, 'mgmt');
  const purchaseAge = rng.int(60, PURCHASE_AGE_DAYS_MAX);
  const attributes = {
    sysName,
    sysDescr: model.manufacturer + ' ' + model.model + ', ' + model.osName + ' ' + model.osVersion,
    sysObjectId: model.sysObjectId.join('.'),
    sysLocation: options.rack ? options.rack.name + ' U' + String(options.uPosition ?? 0) : site.def.name,
    sysContact: 'noc@' + DOMAIN,
    sysUptimeSeconds: rng.int(3600, UPTIME_MAX_SECONDS),
    manufacturer: model.manufacturer,
    model: model.model,
    osName: model.osName,
    osVersion: model.osVersion,
    role: model.role,
    managementIp: alloc.address,
    portCount: model.ports,
    heightU: model.heightU,
    uPosition: options.uPosition,
    assetTag: 'NW-' + rng.alnum(6),
    purchaseDate: dateAt(-purchaseAge),
    warrantyEnd: dateAt(-purchaseAge + WARRANTY_YEARS * DAYS_PER_YEAR),
    snmpVersion: '3',
    haRole:
      model.role === 'firewall' || model.role === 'load_balancer'
        ? site.devices.filter((d) => d.model.role === model.role).length % 2 === 0
          ? 'active'
          : 'standby'
        : null,
  };
  const isLb = model.role === 'load_balancer';
  const idx = isLb
    ? b.ci(
        slot,
        'load_balancer',
        { serialNumber: serial, managementIp: alloc.address },
        sysName,
        {
          ...attributes,
          virtualServers: rng.int(20, 180),
          poolMembers: rng.int(80, 900),
          throughputGbps: 40,
        },
        site.def.code,
        { tags: ['network', model.role], primary: true },
      )
    : b.ci(
        slot,
        'network_device',
        { serialNumber: serial, chassisId, sysName },
        sysName,
        attributes,
        site.def.code,
        { tags: ['network', model.role], primary: true },
      );
  b.rel(slot, 'located_in', idx, options.locatedIn);
  if (options.rack) {
    b.rel(slot, 'powered_by', idx, options.rack.pduA, { feed: 'A', psu: 1 });
    b.rel(slot, 'powered_by', idx, options.rack.pduB, { feed: 'B', psu: 2 });
  }
  attachIp(world, slot, idx, alloc, site.def.code, { interface: 'mgmt0', role: 'management' });

  const device: DeviceRec = {
    idx,
    site,
    model,
    sysName,
    mgmtIp: alloc.address,
    serial,
    rack: options.rack,
    interfaces: [],
    portCursor: 1,
    vlans: new Map(),
    slot,
  };
  for (let port = 1; port <= options.interfaceCount; port++) addInterface(world, rng, device, port, null);
  for (const vlanId of options.vlanIds) {
    const label = options.vlanNames?.[vlanId] ?? vlanLabel(vlanId);
    const vlanIdx = b.ci(
      slot,
      'vlan',
      { deviceRef: networkDeviceRef(serial), vlanId: String(vlanId) },
      'VLAN' + String(vlanId) + ' ' + label,
      { vlanId, name: label, status: 'active', device: sysName },
      site.def.code,
      { tags: ['network'] },
    );
    b.rel(slot, 'contains', idx, vlanIdx);
    device.vlans.set(vlanId, vlanIdx);
  }
  for (const vrf of options.vrfs) {
    const rd = String(65000) + ':' + String(rngRd(vrf));
    const vrfIdx = b.ci(
      slot,
      'vrf',
      { deviceRef: networkDeviceRef(serial), name: vrf },
      vrf + ' on ' + sysName,
      {
        routeDistinguisher: rd,
        routeTargets: ['65000:' + String(rngRd(vrf))],
        routeCount: rng.int(12, 2400),
        device: sysName,
      },
      site.def.code,
      { tags: ['network'] },
    );
    b.rel(slot, 'contains', idx, vrfIdx);
  }
  if (model.role === 'firewall') addFirewallRules(world, rng, device);
  site.devices.push(device);
  return device;
}

function rngRd(vrf: string): number {
  let h = 0;
  for (let i = 0; i < vrf.length; i++) h = (h * 31 + vrf.charCodeAt(i)) % 65000;
  return h + 1;
}

function vlanLabel(vlanId: number): string {
  if (vlanId === VLAN_ID.mgmt) return 'MGMT';
  if (vlanId === VLAN_ID.oob) return 'OOB';
  if (vlanId === VLAN_ID.vmotion) return 'VMOTION';
  if (vlanId === VLAN_ID.storage) return 'STORAGE';
  if (vlanId === VLAN_ID.dmz) return 'DMZ';
  if (vlanId >= VLAN_ID.prodBase && vlanId < VLAN_ID.vmBase)
    return 'PROD-' + String(vlanId - VLAN_ID.prodBase);
  if (vlanId >= HQ_VOICE_VLAN_BASE) return 'VOICE-FL' + String(vlanId - HQ_VOICE_VLAN_BASE);
  if (vlanId >= HQ_DATA_VLAN_BASE) return 'DATA-FL' + String(vlanId - HQ_DATA_VLAN_BASE);
  return 'VLAN' + String(vlanId);
}

export function addInterface(
  world: World,
  rng: Rng,
  device: DeviceRec,
  port: number,
  description: string | null,
): InterfaceRec {
  const { b } = world;
  const existing = device.interfaces.find((i) => i.ifIndex === port);
  if (existing) return existing;
  const name = device.model.ifPrefix + String(port);
  const idx = b.ci(
    device.slot,
    'interface',
    { deviceRef: networkDeviceRef(device.serial), ifIndex: String(port), name },
    device.sysName + ' ' + name,
    {
      ifIndex: port,
      ifDescr: name,
      ifType: 'ethernetCsmacd',
      ifSpeedMbps: device.model.speedMbps,
      ifAdminStatus: 'up',
      ifOperStatus: description === null ? 'down' : 'up',
      ifPhysAddress: rng.mac(ouiFor(device.model.manufacturer)),
      ifMtu:
        device.model.role === 'access' || device.model.role === 'distribution' || device.model.role === 'core'
          ? MTU_JUMBO
          : MTU_DEFAULT,
      ifAlias: description ?? '',
      device: device.sysName,
    },
    device.site.def.code,
    { tags: ['network'] },
  );
  b.rel(device.slot, 'contains', device.idx, idx);
  const rec: InterfaceRec = { idx, name, ifIndex: port };
  device.interfaces.push(rec);
  return rec;
}

/**
 * REQ-IPAM-004 — a MAC learned on a switch port, as the SNMP collector reports a bridge forwarding table: the sorted
 * list (at most LEARNED_MACS_KEPT) and the full count on the interface CI.
 */
export function learnMac(world: World, ifaceIdx: number, mac: string): void {
  const ci = world.b.get(ifaceIdx);
  const current = Array.isArray(ci.attributes['learnedMacs'])
    ? (ci.attributes['learnedMacs'] as string[])
    : [];
  if (current.includes(mac)) return;
  const count =
    (typeof ci.attributes['learnedMacCount'] === 'number'
      ? ci.attributes['learnedMacCount']
      : current.length) + 1;
  ci.attributes['learnedMacs'] = [...current, mac].sort().slice(0, LEARNED_MACS_KEPT);
  ci.attributes['learnedMacCount'] = count;
}

function describe(world: World, iface: InterfaceRec, text: string): void {
  const ci = world.b.get(iface.idx);
  ci.attributes['ifAlias'] = text;
  ci.attributes['ifOperStatus'] = 'up';
}

/** Interface-level adjacency (LLDP/CDP neighbour), recorded from device A's walk. */
export function connect(
  world: World,
  a: DeviceRec,
  ifA: InterfaceRec,
  z: DeviceRec,
  ifZ: InterfaceRec,
  media: string,
): void {
  describe(world, ifA, 'to ' + z.sysName + ' ' + ifZ.name);
  describe(world, ifZ, 'to ' + a.sysName + ' ' + ifA.name);
  world.b.rel(a.slot, 'connected_to', ifA.idx, ifZ.idx, {
    media,
    speedMbps: Math.min(a.model.speedMbps, z.model.speedMbps),
    protocol: 'lldp',
  });
}

/** Next downlink port on a pre-populated device (distribution, core); wraps when all are used. */
function nextPort(device: DeviceRec, maxPort: number): InterfaceRec {
  const port = ((device.portCursor - 1) % maxPort) + 1;
  device.portCursor++;
  const iface = device.interfaces.find((i) => i.ifIndex === port);
  if (!iface) throw new Error('port ' + String(port) + ' missing on ' + device.sysName);
  return iface;
}

/** Host-facing port on a ToR, created on demand, placed in the rack's production VLAN. */
export function allocateHostPort(
  world: World,
  rng: Rng,
  tor: DeviceRec,
  description: string,
  prodVlanId: number,
): InterfaceRec {
  const port = ((tor.portCursor - 1) % ACCESS_HOST_PORTS) + 1;
  tor.portCursor++;
  const fresh = !tor.interfaces.some((i) => i.ifIndex === port);
  const iface = addInterface(world, rng, tor, port, description);
  describe(world, iface, description);
  const vlanIdx = tor.vlans.get(prodVlanId);
  if (fresh && vlanIdx !== undefined)
    world.b.rel(tor.slot, 'in_vlan', iface.idx, vlanIdx, { mode: 'access' });
  return iface;
}

// REQ-IPAM-005 (ADR-064): a zone-based firewall's policy objects, as PAN-OS or FortiGate keep them: an address group
// per zone, service groups, and one group left over from a retired segment that no rule names any more.
const FIREWALL_ZONES = ['trust', 'untrust', 'dmz', 'mgmt', 'partner'] as const;
const FIREWALL_SERVICE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  'svc-web': ['tcp/80', 'tcp/443', 'tcp/8443'],
  'svc-db': ['tcp/1521', 'tcp/5432', 'tcp/1433'],
  'svc-mgmt': ['tcp/22', 'tcp/443', 'udp/161'],
};
const FIREWALL_RETIRED_GROUP = 'net-legacy';
/** Share of rules that name zone and service groups rather than literal prefixes and ports. */
const FIREWALL_OBJECT_SHARE = 0.4;
/** Share of rules nothing has hit since the counters were cleared. */
const FIREWALL_UNUSED_SHARE = 0.15;
/** Share of firewalls carrying a forgotten temporary any-any allow, and a narrower copy of an earlier rule. */
const FIREWALL_TEMP_ANY_SHARE = 0.3;
const FIREWALL_SHADOW_SHARE = 0.4;
const FIREWALL_GROUP_PREFIXES = 2;
const FIREWALL_RULE_ID_STEP = 10;
const FIREWALL_HIT_MAX = 5_000_000;
const SUBNET_PREFIX = 24;
const HALF_SUBNET_PREFIX = 25;

function addFirewallRules(world: World, rng: Rng, device: DeviceRec): void {
  const { b } = world;
  const deviceRef = networkDeviceRef(device.serial);
  const site = device.site.def;
  // Policy objects and the extra rules draw from their own stream, so the rest of the estate is unchanged.
  const side = new Rng('firewall-policy:' + device.serial);
  const objects = new Map<string, number>();
  const addObject = (
    name: string,
    kind: 'address' | 'service',
    elements: readonly string[],
    comment: string | null,
  ): void => {
    const objectId = 'shared/' + name;
    const idx = b.ci(
      device.slot,
      'firewall_object',
      { deviceRef, objectId },
      device.sysName + ' ' + name,
      { objectId, name, kind, elements: [...elements], ...(comment === null ? {} : { comment }) },
      site.code,
      { tags: ['security'] },
    );
    b.rel(device.slot, 'contains', device.idx, idx);
    objects.set(name, idx);
  };
  const sitePrefix = (): string =>
    cidr(RFC1918_TEN, site.octetBase + side.int(0, 15), side.int(0, OCTET_MAX), 0, SUBNET_PREFIX);
  for (const zone of FIREWALL_ZONES)
    addObject(
      'net-' + zone,
      'address',
      Array.from({ length: FIREWALL_GROUP_PREFIXES }, sitePrefix),
      'Networks in the ' + zone + ' zone',
    );
  for (const [name, members] of Object.entries(FIREWALL_SERVICE_GROUPS))
    addObject(name, 'service', members, null);
  addObject(FIREWALL_RETIRED_GROUP, 'address', [sitePrefix()], 'Retired segment');

  let position = 0;
  const addRule = (attributes: Record<string, string | number | boolean>, from: string, to: string): void => {
    position += 1;
    const ruleId = String(position * FIREWALL_RULE_ID_STEP);
    const name =
      typeof attributes['name'] === 'string' ? attributes['name'] : from + '-to-' + to + '-' + ruleId;
    const idx = b.ci(
      device.slot,
      'firewall_rule',
      { deviceRef, ruleId },
      device.sysName + ' rule ' + ruleId + ' ' + from + '-to-' + to,
      { ruleId, name, position, fromZone: from, toZone: to, enabled: true, logging: true, ...attributes },
      site.code,
      { tags: ['security'] },
    );
    b.rel(device.slot, 'contains', device.idx, idx);
    for (const value of [attributes['source'], attributes['destination'], attributes['service']]) {
      const objectIdx =
        typeof value === 'string' && value.startsWith('@') ? objects.get(value.slice(1)) : undefined;
      if (objectIdx !== undefined) b.rel(device.slot, 'references', idx, objectIdx);
    }
  };

  const services = ['tcp/443', 'tcp/8443', 'tcp/22', 'udp/53', 'tcp/1521', 'tcp/5432', 'tcp/1433', 'any'];
  let shadowCandidate: {
    from: string;
    to: string;
    source: string;
    destination: string;
    service: string;
    action: string;
  } | null = null;
  for (let i = 1; i <= FIREWALL_RULES_PER_DEVICE; i++) {
    const from = rng.pick(FIREWALL_ZONES);
    const to = rng.pick(FIREWALL_ZONES.filter((z) => z !== from));
    const src = cidr(RFC1918_TEN, site.octetBase + rng.int(0, 15), rng.int(0, OCTET_MAX), 0, SUBNET_PREFIX);
    const dst = cidr(RFC1918_TEN, site.octetBase + rng.int(0, 15), rng.int(0, OCTET_MAX), 0, SUBNET_PREFIX);
    const action = rng.chance(0.8) ? 'allow' : 'deny';
    const literalService = rng.pick(services);
    const hits = rng.int(0, FIREWALL_HIT_MAX);
    const useGroups = side.chance(FIREWALL_OBJECT_SHARE);
    const source = useGroups ? '@net-' + from : src;
    const destination = useGroups ? '@net-' + to : dst;
    const service = useGroups ? '@' + side.pick(Object.keys(FIREWALL_SERVICE_GROUPS)) : literalService;
    addRule(
      { action, source, destination, service, hitCount: side.chance(FIREWALL_UNUSED_SHARE) ? 0 : hits },
      from,
      to,
    );
    if (!useGroups && literalService !== 'any')
      shadowCandidate = { from, to, source: src, destination: dst, service: literalService, action };
  }
  // A narrower copy of an earlier rule (half its source prefix) that can never match: the earlier rule takes it all.
  if (shadowCandidate !== null && side.chance(FIREWALL_SHADOW_SHARE)) {
    const c = shadowCandidate;
    addRule(
      {
        action: c.action,
        source: c.source.replace('/' + String(SUBNET_PREFIX), '/' + String(HALF_SUBNET_PREFIX)),
        destination: c.destination,
        service: c.service,
        hitCount: 0,
        name: c.from + '-to-' + c.to + '-narrow',
      },
      c.from,
      c.to,
    );
  }
  if (side.chance(FIREWALL_TEMP_ANY_SHARE))
    addRule(
      {
        action: 'allow',
        source: 'any',
        destination: 'any',
        service: 'any',
        hitCount: side.int(0, FIREWALL_HIT_MAX),
        name: 'temp-any-allow',
        logging: false,
      },
      'trust',
      'dmz',
    );
  addRule(
    {
      action: 'deny',
      source: 'any',
      destination: 'any',
      service: 'any',
      hitCount: side.int(0, FIREWALL_HIT_MAX),
      name: 'cleanup-deny',
    },
    'any',
    'any',
  );
}

interface NetworkPlacement {
  rack: RackWorld;
  u: number;
}

const networkRackCursor = new WeakMap<SiteWorld, { rack: RackWorld; nextU: number } | null>();

function placeInNetworkRack(world: World, rng: Rng, site: SiteWorld, heightU: number): NetworkPlacement {
  let cursor = networkRackCursor.get(site) ?? null;
  if (cursor === null || cursor.nextU + heightU - 1 > HOST_TOP_U) {
    const rack = newRack(world, site, rng);
    site.networkRacks.push(rack);
    cursor = { rack, nextU: 1 };
  }
  const placement = { rack: cursor.rack, u: cursor.nextU };
  cursor.nextU += heightU;
  cursor.rack.nextU = cursor.nextU;
  networkRackCursor.set(site, cursor);
  return placement;
}

function rowIndexMap(site: SiteWorld): Map<RowWorld, number> {
  const map = new Map<RowWorld, number>();
  let i = 0;
  for (const room of site.rooms) for (const row of room.rows) map.set(row, i++);
  return map;
}

export function generateNetwork(world: World, rng: Rng): void {
  const { b } = world;
  const total = b.count(SYNTH_ESTATE.networkDevices);
  let created = 0;
  const linkSeq = new Map<SiteWorld, number>();
  const nextLink = (site: SiteWorld): IpAlloc[] => {
    const n = linkSeq.get(site) ?? 0;
    linkSeq.set(site, n + 1);
    const pair = linkPair(site.def.octetBase + POOL.links, n);
    const subnetIdx = ensureSubnet(world, site, pair.cidr, VRF.default, {
      purpose: 'routed point-to-point link',
      prefixLength: 31,
      status: 'active',
      gateway: pair.a,
    });
    return [
      { address: pair.a, subnetIdx, subnetCidr: pair.cidr, gateway: pair.a, vrf: VRF.default },
      { address: pair.z, subnetIdx, subnetCidr: pair.cidr, gateway: pair.a, vrf: VRF.default },
    ];
  };
  const routedLink = (a: DeviceRec, ifA: InterfaceRec, z: DeviceRec, ifZ: InterfaceRec): void => {
    connect(world, a, ifA, z, ifZ, '100GBASE-SR4');
    const [allocA, allocZ] = nextLink(a.site);
    if (!allocA || !allocZ) throw new Error('link allocation failed');
    attachIp(world, a.slot, ifA.idx, allocA, a.site.def.code, { role: 'routed' });
    attachIp(world, z.slot, ifZ.idx, allocZ, z.site.def.code, { role: 'routed' });
  };

  // Data centres, colocation and the HQ server room: cores, firewalls, load balancers, distribution.
  for (const site of world.sites) {
    if (site.def.hostShare <= 0) continue;
    const rows = rowIndexMap(site);
    const coreVrfs = [VRF.default, VRF.mgmt, VRF.prod, VRF.dmz];
    const coreCount = Math.max(MIN_PAIR, b.count(CORE_BASE[site.def.code] ?? MIN_PAIR));
    for (let i = 0; i < coreCount; i++) {
      const model = modelFor('core', rng);
      const p = placeInNetworkRack(world, rng, site, model.heightU);
      const core = addDevice(world, rng, site, model, site.short + '-core-' + pad(i + 1, 2), {
        rack: p.rack,
        uPosition: p.u,
        locatedIn: p.rack.idx,
        vlanIds: [],
        vrfs: coreVrfs,
        interfaceCount: INTERFACES_EMITTED.core,
      });
      site.cores.push(core);
      created++;
    }
    for (let i = 0; i + 1 < site.cores.length; i += 2) {
      const a = site.cores[i];
      const z = site.cores[i + 1];
      if (!a || !z) continue;
      for (const port of CORE_PEER_PORTS) {
        const ifA = a.interfaces.find((x) => x.ifIndex === port);
        const ifZ = z.interfaces.find((x) => x.ifIndex === port);
        if (ifA && ifZ) routedLink(a, ifA, z, ifZ);
      }
    }
    const coreFor = (n: number): DeviceRec => {
      const core = site.cores[n % site.cores.length];
      if (!core) throw new Error('site without cores: ' + site.def.code);
      return core;
    };
    const fwCount = Math.max(MIN_PAIR, b.count(FIREWALL_BASE[site.def.code] ?? MIN_PAIR));
    for (let i = 0; i < fwCount; i++) {
      const model = modelFor('firewall', rng);
      const p = placeInNetworkRack(world, rng, site, model.heightU);
      const fw = addDevice(
        world,
        rng,
        site,
        model,
        site.short + '-fw-' + (i < 2 ? 'edge' : 'dc') + '-' + pad((i % 2) + 1, 2),
        {
          rack: p.rack,
          uPosition: p.u,
          locatedIn: p.rack.idx,
          vlanIds: [],
          vrfs: [VRF.default, VRF.dmz],
          interfaceCount: INTERFACES_EMITTED.firewall,
        },
      );
      site.firewalls.push(fw);
      created++;
      for (let u = 0; u < 2; u++) {
        const ifFw = fw.interfaces[u];
        const core = coreFor(u);
        if (ifFw) routedLink(fw, ifFw, core, nextPort(core, CORE_PEER_PORTS[0] - 1));
      }
    }
    const lbCount =
      LB_BASE[site.def.code] === 0 ? 0 : Math.max(MIN_PAIR, b.count(LB_BASE[site.def.code] ?? 0));
    for (let i = 0; i < lbCount; i++) {
      const model = modelFor('load_balancer', rng);
      const p = placeInNetworkRack(world, rng, site, model.heightU);
      const lb = addDevice(world, rng, site, model, site.short + '-lb-' + pad(i + 1, 2), {
        rack: p.rack,
        uPosition: p.u,
        locatedIn: p.rack.idx,
        vlanIds: [VLAN_ID.dmz],
        vrfs: [],
        interfaceCount: INTERFACES_EMITTED.load_balancer,
      });
      site.loadBalancers.push(lb);
      created++;
      for (let u = 0; u < 2; u++) {
        const ifLb = lb.interfaces[u];
        const core = coreFor(u);
        if (ifLb) connect(world, lb, ifLb, core, nextPort(core, CORE_PEER_PORTS[0] - 1), '40GBASE-SR4');
      }
    }
    for (const room of site.rooms) {
      for (const row of room.rows) {
        const rowNo = rows.get(row) ?? 0;
        const prodVlan = VLAN_ID.prodBase + rowNo;
        for (let d = 0; d < DISTS_PER_ROW; d++) {
          const model = modelFor('distribution', rng);
          const p = placeInNetworkRack(world, rng, site, model.heightU);
          const dist = addDevice(
            world,
            rng,
            site,
            model,
            site.short +
              '-' +
              room.name.toLowerCase() +
              '-' +
              row.name.toLowerCase() +
              '-dist-' +
              pad(d + 1, 2),
            {
              rack: p.rack,
              uPosition: p.u,
              locatedIn: p.rack.idx,
              vlanIds: [VLAN_ID.mgmt, VLAN_ID.oob, prodVlan, VLAN_ID.vmotion, VLAN_ID.storage, VLAN_ID.dmz],
              vrfs: [VRF.default, VRF.mgmt, VRF.oob, VRF.prod, VRF.dmz],
              interfaceCount: INTERFACES_EMITTED.distribution,
            },
          );
          row.dists.push(dist);
          site.dists.push(dist);
          created++;
          DIST_UPLINK_PORTS.forEach((port, u) => {
            const ifDist = dist.interfaces.find((x) => x.ifIndex === port);
            const core = coreFor(u);
            if (ifDist) routedLink(dist, ifDist, core, nextPort(core, CORE_PEER_PORTS[0] - 1));
          });
        }
      }
    }
  }

  // Branches: one WAN router and one switch per location, addressed from the branch /24.
  const branchSite = world.sites.find((s) => s.def.kind === 'branch');
  if (branchSite) {
    const branches = b.count(BRANCH_BASE_COUNT);
    for (let n = 0; n < branches; n++) {
      const second = branchSite.def.octetBase + (n >> 8);
      const third = n & OCTET_MAX;
      const lan = cidr(RFC1918_TEN, second, third, 0, 24);
      const subnetIdx = ensureSubnet(world, branchSite, lan, VRF.default, {
        purpose: 'branch LAN',
        branch: n + 1,
        gateway: ip4(RFC1918_TEN, second, third, BRANCH_ROUTER_HOST),
        prefixLength: 24,
        status: 'active',
      });
      world.branchSubnets.push(subnetIdx);
      world.branchCidrs.push(lan);
      const code = 'br' + pad(n + 1, 3);
      const routerAlloc: IpAlloc = {
        address: ip4(RFC1918_TEN, second, third, BRANCH_ROUTER_HOST),
        subnetIdx,
        subnetCidr: lan,
        gateway: ip4(RFC1918_TEN, second, third, BRANCH_ROUTER_HOST),
        vrf: VRF.default,
      };
      const switchAlloc: IpAlloc = {
        ...routerAlloc,
        address: ip4(RFC1918_TEN, second, third, BRANCH_SWITCH_HOST),
      };
      const router = addDevice(world, rng, branchSite, modelFor('wan_router', rng), code + '-rtr-01', {
        rack: null,
        uPosition: null,
        locatedIn: branchSite.ciIdx,
        vlanIds: [],
        vrfs: [VRF.default],
        ipOverride: routerAlloc,
        interfaceCount: 0,
      });
      const sw = addDevice(world, rng, branchSite, modelFor('branch_switch', rng), code + '-sw-01', {
        rack: null,
        uPosition: null,
        locatedIn: branchSite.ciIdx,
        vlanIds: BRANCH_VLANS,
        vlanNames: BRANCH_VLAN_NAMES,
        vrfs: [],
        ipOverride: switchAlloc,
        interfaceCount: INTERFACES_EMITTED.branch_switch,
      });
      created += 2;
      const wan = addInterface(world, rng, router, BRANCH_ROUTER_WAN_PORT, 'SD-WAN underlay');
      describe(world, wan, 'SD-WAN underlay to RYD/JED');
      const lanIf = addInterface(world, rng, router, BRANCH_ROUTER_LAN_PORT, 'LAN');
      const uplink = addInterface(world, rng, sw, BRANCH_SWITCH_UPLINK_PORT, 'uplink');
      connect(world, sw, uplink, router, lanIf, '1000BASE-T');
      b.get(router.idx).attributes['branchNumber'] = n + 1;
      b.get(sw.idx).attributes['branchNumber'] = n + 1;
    }
  }

  // Access layer: ToR A/B and a management switch per rack, then HQ campus switches.
  const rackedSites = world.sites.filter((s) => s.def.hostShare > 0);
  const allRacks = rackedSites.flatMap((s) => s.racks.map((rack) => ({ site: s, rack })));
  const hq = world.sites.find((s) => s.def.kind === 'office');
  const hqCampus = hq ? b.count(HQ_CAMPUS_ACCESS_BASE) : 0;
  const accessBudget = Math.max(allRacks.length, total - created - hqCampus);
  let accessCreated = 0;
  const addTor = (
    site: SiteWorld,
    rack: RackWorld,
    u: number,
    suffix: string,
    role: 'access' | 'management',
  ): void => {
    const rows = rowIndexMap(site);
    const prodVlan = VLAN_ID.prodBase + (rows.get(rack.row) ?? 0);
    const model = modelFor(role, rng);
    const device = addDevice(world, rng, site, model, rack.name.toLowerCase() + '-' + suffix, {
      rack,
      uPosition: u,
      locatedIn: rack.idx,
      vlanIds:
        role === 'access'
          ? [VLAN_ID.mgmt, VLAN_ID.oob, prodVlan, VLAN_ID.vmotion, VLAN_ID.storage]
          : [VLAN_ID.mgmt, VLAN_ID.oob],
      vrfs: [],
      interfaceCount: role === 'access' ? 0 : INTERFACES_EMITTED.management,
    });
    accessCreated++;
    if (role === 'access') {
      rack.tors.push(device);
      for (let u2 = 0; u2 < UPLINKS_PER_ACCESS; u2++) {
        const iface = addInterface(world, rng, device, ACCESS_UPLINK_PORT_BASE + u2, 'uplink');
        const dist = rack.row.dists[u2 % Math.max(1, rack.row.dists.length)];
        if (dist) connect(world, device, iface, dist, nextPort(dist, DIST_DOWNLINK_PORTS), '25GBASE-SR');
      }
    } else {
      const iface = device.interfaces[0];
      const tor = rack.tors[0];
      if (iface && tor)
        connect(
          world,
          device,
          iface,
          tor,
          addInterface(world, rng, tor, ACCESS_UPLINK_PORT_BASE + UPLINKS_PER_ACCESS, 'mgmt switch'),
          '1000BASE-T',
        );
    }
  };
  for (const { site, rack } of allRacks)
    if (accessCreated < accessBudget) addTor(site, rack, TOR_A_U, 'tor-a', 'access');
  for (const { site, rack } of allRacks)
    if (accessCreated < accessBudget) addTor(site, rack, TOR_B_U, 'tor-b', 'access');
  for (const { site, rack } of allRacks)
    if (accessCreated < accessBudget) addTor(site, rack, MGMT_SWITCH_U, 'mgmt-01', 'management');
  created += accessCreated;

  if (hq) {
    const campusTotal = hqCampus + Math.max(0, total - created);
    for (let i = 0; i < campusTotal; i++) {
      const floor = (i % HQ_FLOORS) + 1;
      const perFloor = Math.floor(i / HQ_FLOORS) + 1;
      const model = modelFor('access', rng);
      const sw = addDevice(world, rng, hq, model, 'hq-fl' + pad(floor, 2) + '-sw-' + pad(perFloor, 2), {
        rack: null,
        uPosition: null,
        locatedIn: hq.buildingIdx,
        vlanIds: [VLAN_ID.mgmt, HQ_DATA_VLAN_BASE + floor, HQ_VOICE_VLAN_BASE + floor],
        vrfs: [],
        interfaceCount: 0,
      });
      for (let u = 0; u < UPLINKS_PER_ACCESS; u++) {
        const iface = addInterface(world, rng, sw, ACCESS_UPLINK_PORT_BASE + u, 'uplink');
        const core = hq.cores[u % Math.max(1, hq.cores.length)];
        if (core) connect(world, sw, iface, core, nextPort(core, CORE_PEER_PORTS[0] - 1), '10GBASE-LR');
      }
      b.get(sw.idx).attributes['floor'] = floor;
    }
  }
}
