// REQ-QA-001 — organization, sites, inter-site links and IPAM supernets.
import { organizationSchema, siteLinkSchema, siteSchema, type LINK_KINDS, type Organization, type Site, type SiteLink } from '@openmap/contracts';
import { BUSINESS_UNITS, INDUSTRY, ORGANIZATION_NAME, POOL, REGULATORY_SCOPE, SITES, TIME_ZONE } from '../catalog.js';
import { cidr, ip4, RFC1918_TEN } from '../ip.js';
import type { Rng } from '../rng.js';
import { isoAt } from '../time.js';
import { dcimSlot, ipamSlot, shortCode, siteOf, type SiteWorld, type World } from '../world.js';

type LinkKind = (typeof LINK_KINDS)[number];

interface LinkDef {
  from: string;
  to: string;
  kind: LinkKind;
  provider: string;
  bandwidthMbps: number;
  diversePaths: number;
  role: 'primary' | 'backup' | 'overlay';
  latencyMs: number;
  replication?: boolean;
}

const LINKS: readonly LinkDef[] = [
  { from: 'RYD', to: 'JED', kind: 'dark_fibre', provider: 'stc', bandwidthMbps: 100_000, diversePaths: 2, role: 'primary', latencyMs: 12.4, replication: true },
  { from: 'RYD', to: 'JED', kind: 'mpls', provider: 'Mobily', bandwidthMbps: 10_000, diversePaths: 1, role: 'backup', latencyMs: 18.9 },
  { from: 'RYD', to: 'DMM-COLO', kind: 'dark_fibre', provider: 'stc', bandwidthMbps: 100_000, diversePaths: 2, role: 'primary', latencyMs: 6.1 },
  { from: 'JED', to: 'DMM-COLO', kind: 'mpls', provider: 'Mobily', bandwidthMbps: 10_000, diversePaths: 1, role: 'backup', latencyMs: 21.3 },
  { from: 'HQ', to: 'RYD', kind: 'mpls', provider: 'stc', bandwidthMbps: 10_000, diversePaths: 2, role: 'primary', latencyMs: 1.2 },
  { from: 'HQ', to: 'RYD', kind: 'sd_wan', provider: 'Zain', bandwidthMbps: 2_000, diversePaths: 1, role: 'overlay', latencyMs: 4.5 },
  { from: 'BRANCH', to: 'RYD', kind: 'sd_wan', provider: 'stc', bandwidthMbps: 200, diversePaths: 2, role: 'primary', latencyMs: 9.8 },
  { from: 'BRANCH', to: 'JED', kind: 'sd_wan', provider: 'Mobily', bandwidthMbps: 200, diversePaths: 1, role: 'backup', latencyMs: 15.2 },
  { from: 'RYD', to: 'AZ-UAEN', kind: 'expressroute', provider: 'Equinix', bandwidthMbps: 10_000, diversePaths: 2, role: 'primary', latencyMs: 24.7 },
  { from: 'JED', to: 'AZ-UAEN', kind: 'expressroute', provider: 'Equinix', bandwidthMbps: 5_000, diversePaths: 1, role: 'backup', latencyMs: 31.0 },
  { from: 'RYD', to: 'AWS-MES1', kind: 'direct_connect', provider: 'Equinix', bandwidthMbps: 10_000, diversePaths: 2, role: 'primary', latencyMs: 19.6 },
  { from: 'AZ-UAEN', to: 'AWS-MES1', kind: 'cloud_interconnect', provider: 'Megaport', bandwidthMbps: 1_000, diversePaths: 1, role: 'overlay', latencyMs: 8.3 },
];

const BRANCH_BASE_COUNT = 212;
const SUPERNET_PREFIX_ROOT = 8;
const SUPERNET_PREFIX_SITE = 12;
/** Design power capacity by site kind, kW. */
const FACILITY_KW: Record<string, number> = { datacenter: 4800, colocation: 1200, office: 320, branch: 8 };
const DESIGN_PUE = 1.4;
/** ADR-025: link probes connect to the far gateway's HTTPS port; the committed latency is twice the nominal figure. */
const PROBE_PORT = 443;
const SLA_LATENCY_HEADROOM = 2;

export interface OrganizationBundle {
  organization: Organization;
  sites: Site[];
  siteLinks: SiteLink[];
}

export function generateSites(world: World, rng: Rng): OrganizationBundle {
  const { b } = world;
  const organizationId = rng.uuid();
  const businessUnits = BUSINESS_UNITS.map((name, i) => ({ tenantId: i === BUSINESS_UNITS.length - 1 ? b.tenantId : rng.uuid(), name }));
  const organization = organizationSchema.parse({
    id: organizationId,
    name: ORGANIZATION_NAME,
    industry: INDUSTRY,
    timeZone: TIME_ZONE,
    defaultLocale: 'en',
    regulatoryScope: [...REGULATORY_SCOPE],
    businessUnits,
    airGapped: true,
    createdAt: isoAt(0),
  });

  const branchCount = b.count(BRANCH_BASE_COUNT);
  const sites: Site[] = [];
  for (const def of SITES) {
    const nodeId = def.nodeIds[0];
    if (nodeId === undefined) throw new Error('site without a node: ' + def.code);
    const site: SiteWorld = {
      def,
      short: shortCode(def),
      siteId: rng.uuid(),
      ciIdx: -1,
      buildingIdx: -1,
      supernetIdx: -1,
      rooms: [],
      racks: [],
      storageRacks: [],
      networkRacks: [],
      hosts: [],
      devices: [],
      cores: [],
      dists: [],
      firewalls: [],
      loadBalancers: [],
      hypervisors: [],
      vms: [],
      storageArrays: [],
      k8sClusters: [],
      poolCursor: new Map(),
      subnets: new Map(),
      ipamSlot: null,
      nodeId,
      cloudAccountIdx: -1,
    };
    world.sites.push(site);
    const locationCount = def.kind === 'branch' ? branchCount : 1;
    const slot = dcimSlot(world, site);
    site.ciIdx = b.ci(
      slot,
      'site',
      { code: def.code },
      def.name,
      {
        kind: def.kind,
        tier: def.tier,
        drRole: def.drRole,
        criticality: def.criticality,
        city: def.city,
        countryCode: def.countryCode,
        address: def.address,
        latitude: def.lat,
        longitude: def.lon,
        locationCount,
        cloudProvider: def.cloud?.provider ?? null,
        cloudRegion: def.cloud?.region ?? null,
        timeZone: TIME_ZONE,
        discoveryNodes: def.nodeIds,
      },
      def.code,
      { tags: ['site', def.kind] },
    );
    sites.push(
      siteSchema.parse({
        id: site.siteId,
        organizationId,
        code: def.code,
        name: def.name,
        kind: def.kind,
        tier: def.tier,
        address: def.address,
        city: def.city,
        countryCode: def.countryCode,
        geo: { lat: def.lat, lon: def.lon },
        cloud: def.cloud,
        locationCount,
        facility: def.cloud ? null : { powerCapacityKw: FACILITY_KW[def.kind] ?? 0, rackCount: 0, designPue: def.kind === 'datacenter' || def.kind === 'colocation' ? DESIGN_PUE : null },
        ciId: null,
      }),
    );
  }

  // Supernets: the whole private /8 under RYD, one /12 per site.
  const ryd = siteOf(world, 'RYD');
  const rootSlot = ipamSlot(world, ryd);
  const rootCidr = cidr(RFC1918_TEN, 0, 0, 0, SUPERNET_PREFIX_ROOT);
  const rootIdx = b.ci(rootSlot, 'subnet', { cidr: rootCidr, vrfRef: 'global' }, rootCidr, { purpose: 'enterprise private address space', prefixLength: SUPERNET_PREFIX_ROOT, status: 'container', vrf: 'global' }, 'RYD', { tags: ['ipam', 'supernet'] });
  for (const site of world.sites) {
    const slot = ipamSlot(world, site);
    const siteCidr = cidr(RFC1918_TEN, site.def.octetBase, 0, 0, SUPERNET_PREFIX_SITE);
    site.supernetIdx = b.ci(slot, 'subnet', { cidr: siteCidr, vrfRef: 'global' }, siteCidr, { purpose: site.def.name + ' supernet', prefixLength: SUPERNET_PREFIX_SITE, status: 'container', vrf: 'global', site: site.def.code }, site.def.code, { tags: ['ipam', 'supernet'] });
    b.rel(slot, 'contains', rootIdx, site.supernetIdx);
  }

  const siteLinks: SiteLink[] = [];
  for (const link of LINKS) {
    const from = siteOf(world, link.from);
    const to = siteOf(world, link.to);
    const circuitId = link.provider.toUpperCase().slice(0, 4) + '-' + link.kind.toUpperCase().replace('_', '').slice(0, 4) + '-' + rng.alnum(8);
    const slot = dcimSlot(world, from);
    const name = from.def.code + ' to ' + to.def.code + ' ' + link.kind.replace('_', ' ') + ' (' + link.role + ')';
    const linkIdx = b.ci(
      slot,
      'site_link',
      { circuitId, fromSiteRef: from.def.code, toSiteRef: to.def.code },
      name,
      {
        kind: link.kind,
        provider: link.provider,
        bandwidthMbps: link.bandwidthMbps,
        diversePaths: link.diversePaths,
        role: link.role,
        latencyMs: link.latencyMs,
        status: 'up',
        utilisationPercent: rng.int(5, 70),
        // ADR-025: what the A end probes (the far site's WAN gateway), the provider's latency commitment, and whether
        // the circuit carries storage and database replication (the dark fibre between the primary and DR sites).
        replication: link.replication === true,
        probeTarget: ip4(RFC1918_TEN, to.def.octetBase + POOL.links, 0, 1) + ':' + String(PROBE_PORT),
        slaLatencyMs: Math.ceil(link.latencyMs * SLA_LATENCY_HEADROOM),
      },
      from.def.code,
      { tags: ['wan', link.kind] },
    );
    b.rel(slot, 'connected_to', linkIdx, from.ciIdx, { end: 'A' });
    b.rel(slot, 'connected_to', linkIdx, to.ciIdx, { end: 'Z' });
    siteLinks.push(
      siteLinkSchema.parse({
        id: rng.uuid(),
        organizationId,
        fromSiteId: from.siteId,
        toSiteId: to.siteId,
        kind: link.kind,
        provider: link.provider,
        circuitId,
        bandwidthMbps: link.bandwidthMbps,
        diversePaths: link.diversePaths,
        role: link.role,
        latencyMs: link.latencyMs,
        ciId: null,
        carrierContractRef: 'CTR-' + link.provider.toUpperCase().replace(/[^A-Z]/g, '') + '-' + rng.alnum(6),
        telemetry: {
          latencyMs: link.latencyMs,
          jitterMs: Number(rng.float(0.1, 2.5).toFixed(2)),
          throughputMbps: Math.round(link.bandwidthMbps * rng.float(0.05, 0.7)),
          lossPercent: Number(rng.float(0, 0.05).toFixed(3)),
          redundancyState: link.diversePaths > 1 ? 'active_active' : 'active_standby',
          observedAt: isoAt(0),
        },
      }),
    );
  }

  return { organization, sites, siteLinks };
}
