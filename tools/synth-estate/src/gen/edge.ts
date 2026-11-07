// REQ-QA-001 — edge of the estate: DNS zones and records for every host and VM, DHCP scopes for
// branches and HQ floors with leases, and unclassified devices found by the port scanner with
// sysDescr-like fingerprints.
import { DOMAIN, POOL, UNKNOWN_DEVICES } from '../catalog.js';
import type { Slot } from '../estate.js';
import { cidr, ip4, OCTET_MAX, RFC1918_TEN } from '../ip.js';
import type { Rng } from '../rng.js';
import { isoAt, MS_PER_DAY, MS_PER_HOUR } from '../time.js';
import { allocateIp, attachIp, fqdnOf, pad, siteOf, type IpAlloc, type SiteWorld, type World } from '../world.js';

const UNKNOWN_BASE = 214;
const HQ_USER_SCOPES_BASE = 10;
const UNKNOWN_PLACEMENT_WEIGHTS: readonly number[] = [70, 20, 10];
const DHCP_RANGE_START = 100;
const DHCP_RANGE_END = 250;
const LEASE_SECONDS = 86_400;
const REVERSE_ZONE = '10.in-addr.arpa';
const DNS_TTL = 3600;
const SOA_REFRESH = 7200;

function dnsSlot(world: World): Slot {
  const site = siteOf(world, 'RYD');
  return world.b.slotFor('dns', {
    family: 'dns',
    collectorId: 'dns-bind',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'zone', value: DOMAIN, label: 'internal forward zone' },
    evidenceKind: 'api_response',
  });
}

function dhcpSlot(world: World): Slot {
  const site = siteOf(world, 'RYD');
  return world.b.slotFor('dhcp', {
    family: 'dhcp',
    collectorId: 'dhcp-kea',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'host', value: fqdnOf('dhcp-ryd-01'), label: 'central DHCP (Kea)' },
    evidenceKind: 'api_response',
  });
}

function scanSlot(world: World, site: SiteWorld): Slot {
  const target = site.def.kind === 'branch' ? cidr(RFC1918_TEN, site.def.octetBase, 0, 0, 12) : cidr(RFC1918_TEN, site.def.octetBase + POOL.mgmt, 0, 0, 16);
  return world.b.slotFor('portscan|' + site.nodeId, {
    family: 'port_scan',
    collectorId: 'port-scan',
    nodeId: site.nodeId,
    siteCode: site.def.code,
    target: { kind: 'cidr', value: target, label: site.def.code + ' discovery sweep' },
    evidenceKind: 'scan_output',
  });
}

function generateDns(world: World): void {
  const { b } = world;
  const slot = dnsSlot(world);
  const ryd = siteOf(world, 'RYD');
  const dnsServers = (world.infraListeners.get('infra-dns') ?? []).map((l) => b.get(l.computeIdx).name + '.' + DOMAIN);
  const zoneIdx = b.ci(slot, 'dns_zone', { name: DOMAIN }, DOMAIN, { type: 'primary', serial: 2026100101, nameservers: dnsServers, ttl: DNS_TTL, refresh: SOA_REFRESH, dnssec: false, server: 'BIND 9.18.28' }, ryd.def.code, { tags: ['dns'] });
  b.ci(slot, 'dns_zone', { name: REVERSE_ZONE }, REVERSE_ZONE, { type: 'primary', serial: 2026100101, nameservers: dnsServers, ttl: DNS_TTL, refresh: SOA_REFRESH, dnssec: false, server: 'BIND 9.18.28' }, ryd.def.code, { tags: ['dns'] });
  const addA = (fqdn: string, address: string, ipIdx: number, siteCode: string): void => {
    const idx = b.ci(slot, 'dns_record', { zoneRef: DOMAIN, name: fqdn, recordType: 'A', value: address }, fqdn + ' A ' + address, { recordType: 'A', ttl: DNS_TTL, value: address, zone: DOMAIN }, siteCode, { tags: ['dns'] });
    b.rel(slot, 'contains', zoneIdx, idx);
    b.rel(slot, 'resolves_to', idx, ipIdx);
    b.countPrimary(slot);
  };
  for (const site of world.sites) {
    for (const host of site.hosts) addA(host.fqdn, host.ip, host.ipIdx, site.def.code);
    for (const vm of site.vms) addA(vm.fqdn, vm.ip, vm.ipIdx, site.def.code);
  }
  for (const app of world.applications) {
    const web = app.components.find((c) => c.tier === 'web');
    const first = web?.computeIdx[0];
    if (first === undefined) continue;
    const target = b.get(first);
    // A CNAME's target is an absolute name, written with its trailing dot, as a zone transfer returns it (the DNS
    // collector keeps rdata in master-file form).
    const value = (target.identity['fqdn'] ?? target.name + '.' + DOMAIN) + '.';
    const alias = app.slug + '.' + DOMAIN;
    const idx = b.ci(slot, 'dns_record', { zoneRef: DOMAIN, name: alias, recordType: 'CNAME', value }, alias + ' CNAME ' + value, { recordType: 'CNAME', ttl: DNS_TTL, value, zone: DOMAIN }, app.site.def.code, { tags: ['dns'] });
    b.rel(slot, 'contains', zoneIdx, idx);
    b.countPrimary(slot);
  }
  b.get(zoneIdx).attributes['recordCount'] = world.b.cis.filter((c) => c.type === 'dns_record').length;
}

interface UnknownRec {
  idx: number;
  address: string;
  mac: string;
  sysName: string;
  branch: number;
}

function generateUnknowns(world: World, rng: Rng): UnknownRec[] {
  const { b } = world;
  const branchSite = world.sites.find((s) => s.def.kind === 'branch');
  const hq = siteOf(world, 'HQ');
  const ryd = siteOf(world, 'RYD');
  const total = b.count(UNKNOWN_BASE);
  const perBranch = new Map<number, number>();
  const out: UnknownRec[] = [];
  for (let i = 0; i < total; i++) {
    const def = rng.pick(UNKNOWN_DEVICES);
    const placement = rng.weighted(UNKNOWN_PLACEMENT_WEIGHTS);
    let site: SiteWorld;
    let alloc: IpAlloc;
    let branch = -1;
    let location: string;
    if (placement === 0 && branchSite && world.branchSubnets.length > 0) {
      branch = rng.int(0, world.branchSubnets.length - 1);
      const used = perBranch.get(branch) ?? 0;
      perBranch.set(branch, used + 1);
      const second = branchSite.def.octetBase + (branch >> 8);
      const third = branch & OCTET_MAX;
      const host = DHCP_RANGE_START + (used % (DHCP_RANGE_END - DHCP_RANGE_START));
      const subnetIdx = world.branchSubnets[branch];
      const lan = world.branchCidrs[branch];
      if (subnetIdx === undefined || lan === undefined) throw new Error('branch subnet missing');
      alloc = { address: ip4(RFC1918_TEN, second, third, host), subnetIdx, subnetCidr: lan, gateway: ip4(RFC1918_TEN, second, third, 1), vrf: 'default' };
      site = branchSite;
      location = 'BR-' + pad(branch + 1, 3);
    } else if (placement === 1) {
      site = hq;
      alloc = allocateIp(world, hq, 'dmz');
      location = 'HQ floor ' + String(rng.int(1, 32));
    } else {
      site = ryd;
      alloc = allocateIp(world, ryd, 'mgmt');
      location = 'RYD data hall';
    }
    const slot = scanSlot(world, site);
    const mac = rng.mac(def.oui);
    const sysName = def.kind + '-' + rng.hex(4);
    const idx = b.ci(
      slot,
      'unknown',
      { address: alloc.address, primaryMac: mac },
      sysName,
      { sysDescr: def.sysDescr, sysName, deviceKind: def.kind, openPorts: [...def.ports], vendorFromOui: def.vendor, osGuess: def.sysDescr.includes('Linux') ? 'Linux' : 'embedded', ttl: rng.pick([64, 128, 255]), httpBanner: def.ports.includes(80) ? def.vendor + ' embedded web server' : null, snmpReachable: def.ports.includes(161), location, firstSeen: isoAt(-rng.int(1, 400) * MS_PER_DAY), lastSeen: isoAt(-rng.int(0, 48) * MS_PER_HOUR) },
      site.def.code,
      { tags: ['unclassified', def.kind], primary: true },
    );
    b.rel(slot, 'located_in', idx, site.ciIdx);
    attachIp(world, slot, idx, alloc, site.def.code, { macAddress: mac, source: 'port_scan' });
    out.push({ idx, address: alloc.address, mac, sysName, branch });
    if (branch >= 0) {
      const list = world.unknownByBranch.get(branch) ?? [];
      list.push(idx);
      world.unknownByBranch.set(branch, list);
    }
  }
  return out;
}

function generateDhcp(world: World, rng: Rng, unknowns: UnknownRec[]): void {
  const { b } = world;
  const slot = dhcpSlot(world);
  const serverRef = fqdnOf('dhcp-ryd-01');
  const dnsServers = (world.infraListeners.get('infra-dns') ?? []).map((l) => l.ip);
  const branchSite = world.sites.find((s) => s.def.kind === 'branch');
  const scopeByBranch = new Map<number, { idx: number; cidr: string }>();
  if (branchSite) {
    world.branchCidrs.forEach((lan, n) => {
      const subnetIdx = world.branchSubnets[n];
      if (subnetIdx === undefined) return;
      const second = branchSite.def.octetBase + (n >> 8);
      const third = n & OCTET_MAX;
      const idx = b.ci(slot, 'dhcp_scope', { serverRef, cidr: lan }, 'BR-' + pad(n + 1, 3) + ' ' + lan, { cidr: lan, rangeStart: ip4(RFC1918_TEN, second, third, DHCP_RANGE_START), rangeEnd: ip4(RFC1918_TEN, second, third, DHCP_RANGE_END), gateway: ip4(RFC1918_TEN, second, third, 1), dnsServers, leaseSeconds: LEASE_SECONDS, utilisationPercent: rng.int(5, 60), branch: n + 1, server: serverRef, relayAgent: 'br' + pad(n + 1, 3) + '-rtr-01' }, branchSite.def.code, { tags: ['dhcp'], primary: true });
      b.rel(slot, 'in_subnet', idx, subnetIdx);
      scopeByBranch.set(n, { idx, cidr: lan });
    });
  }
  const hq = siteOf(world, 'HQ');
  const hqScopes = b.count(HQ_USER_SCOPES_BASE);
  for (let f = 0; f < hqScopes; f++) {
    const alloc = allocateIp(world, hq, 'dmz');
    const parts = alloc.subnetCidr.split('/')[0]?.split('.') ?? [];
    const base = parts.slice(0, 3).map(Number);
    const [a, bOct, c] = base;
    if (a === undefined || bOct === undefined || c === undefined) continue;
    const idx = b.ci(slot, 'dhcp_scope', { serverRef, cidr: alloc.subnetCidr }, 'HQ floor ' + String(f + 1) + ' ' + alloc.subnetCidr, { cidr: alloc.subnetCidr, rangeStart: ip4(a, bOct, c, DHCP_RANGE_START), rangeEnd: ip4(a, bOct, c, DHCP_RANGE_END), gateway: alloc.gateway, dnsServers, leaseSeconds: LEASE_SECONDS, utilisationPercent: rng.int(20, 85), floor: f + 1, server: serverRef, relayAgent: 'hq-core-01' }, hq.def.code, { tags: ['dhcp'], primary: true });
    b.rel(slot, 'in_subnet', idx, alloc.subnetIdx);
  }
  for (const u of unknowns) {
    if (u.branch < 0) continue;
    const scope = scopeByBranch.get(u.branch);
    if (!scope) continue;
    const leaseIdx = b.ci(slot, 'dhcp_lease', { scopeRef: scope.cidr, address: u.address }, u.address + ' lease', { address: u.address, mac: u.mac, hostname: u.sysName, state: 'active', expiresAt: isoAt(rng.int(1, 24) * MS_PER_HOUR), scope: scope.cidr, clientId: '01:' + u.mac }, 'BRANCH', { tags: ['dhcp'] });
    b.rel(slot, 'contains', scope.idx, leaseIdx);
    b.rel(slot, 'leased_to', leaseIdx, u.idx);
  }
}

export function generateEdge(world: World, rng: Rng): void {
  const unknowns = generateUnknowns(world, rng.fork('unknown'));
  generateDns(world);
  generateDhcp(world, rng.fork('dhcp'), unknowns);
}
