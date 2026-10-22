// REQ-QA-001 — in-memory estate model and builder. buildEstate(seed, scale) produces every CI and
// relationship of the synthetic bank estate, each tagged with the collector "slot" (family,
// collector id, Discovery Node, target, sweep chunk) that will later emit it. Relationships point
// at CI indices so the model stays compact at scale 1 (hundreds of thousands of CIs).
import { PERF_BUDGETS, SYNTH_ESTATE } from '@openmap/constants';
import { CI_IDENTITY_KEYS, CI_TYPE_LAYER, type Attributes, type CiLayer, type CiType, type CollectorFamily, type Organization, type RelationshipType, type Site, type SiteLink, type Target } from '@openmap/contracts';
import { Rng } from './rng.js';
import { isoAt, MS_PER_SECOND } from './time.js';
import { generateSites, type SiteWorld } from './gen/sites.js';
import { planHosts, type HostPlan } from './gen/plan.js';
import { generateFacilities } from './gen/facilities.js';
import { generateNetwork } from './gen/network.js';
import { generateHosts } from './gen/hosts.js';
import { generateVirtualization } from './gen/virtualization.js';
import { generateStorage } from './gen/storage.js';
import { generateKubernetes } from './gen/kubernetes.js';
import { generateApplications, type BusinessServiceRecord } from './gen/applications.js';
import { generateEdge } from './gen/edge.js';
import { generateCloud } from './gen/cloud.js';
import { generateCommercial } from './gen/commercial.js';
import { generateFlows } from './gen/flows.js';

export type EvidenceKind = 'snmp_walk' | 'cli_output' | 'api_response' | 'flow_sample' | 'scan_output' | 'agent_report';

export interface SlotSpec {
  family: CollectorFamily;
  collectorId: string;
  nodeId: string;
  siteCode: string;
  target: Target;
  evidenceKind: EvidenceKind;
}

/** One future CollectorResult: everything added to a slot is emitted together. */
export interface Slot extends SlotSpec {
  id: number;
  /** Sweep targets (devices, hosts, VMs…) in this chunk; capped at PERF_BUDGETS.discoverySweepDevices. */
  primaryCount: number;
  observedAt: string;
}

export interface EstateCi {
  idx: number;
  slot: number;
  type: CiType;
  identity: Record<string, string>;
  name: string;
  attributes: Attributes;
  tags: string[];
  externalIds: Array<{ source: string; id: string }>;
  siteCode: string;
}

export interface EstateRel {
  type: RelationshipType;
  from: number;
  to: number;
  slot: number;
  attributes: Attributes | null;
}

export interface CiOptions {
  tags?: string[];
  externalIds?: Array<{ source: string; id: string }>;
  /** Counts toward the slot's sweep-chunk size. */
  primary?: boolean;
}

const EMPTY_TAGS: string[] = [];
const EMPTY_EXTERNAL: Array<{ source: string; id: string }> = [];

export class EstateBuilder {
  readonly cis: EstateCi[] = [];
  readonly rels: EstateRel[] = [];
  readonly slots: Slot[] = [];
  private readonly open = new Map<string, Slot>();

  constructor(
    readonly seed: number,
    readonly scale: number,
    readonly tenantId: string,
    readonly maxPrimaryPerSlot: number = PERF_BUDGETS.discoverySweepDevices,
  ) {}

  /** Scaled count, never below `min`. */
  count(base: number, min = 1): number {
    return Math.max(min, Math.round(base * this.scale));
  }

  /**
   * Returns the open slot for `key`, opening a new one when the current chunk has reached the
   * sweep size. Generators call this once per sweep target and attach the target's child CIs.
   */
  slotFor(key: string, spec: SlotSpec): Slot {
    const current = this.open.get(key);
    if (current && current.primaryCount < this.maxPrimaryPerSlot) return current;
    const slot: Slot = { ...spec, id: this.slots.length, primaryCount: 0, observedAt: isoAt(this.slots.length * 7 * MS_PER_SECOND) };
    this.slots.push(slot);
    this.open.set(key, slot);
    return slot;
  }

  /** Counts a sweep target that has no CI of its own in this slot (flow records, scan probes). */
  countPrimary(slot: Slot): void {
    slot.primaryCount++;
  }

  ci(slot: Slot, type: CiType, identity: Record<string, string>, name: string, attributes: Attributes, siteCode: string, options: CiOptions = {}): number {
    for (const key of CI_IDENTITY_KEYS[type]) {
      const value = identity[key];
      if (value === undefined || value.length === 0) throw new Error('missing identity key ' + key + ' for ' + type + ' ' + name);
    }
    const idx = this.cis.length;
    this.cis.push({ idx, slot: slot.id, type, identity, name, attributes, tags: options.tags ?? EMPTY_TAGS, externalIds: options.externalIds ?? EMPTY_EXTERNAL, siteCode });
    if (options.primary === true) slot.primaryCount++;
    return idx;
  }

  rel(slot: Slot, type: RelationshipType, from: number, to: number, attributes: Attributes | null = null): void {
    if (from < 0 || from >= this.cis.length || to < 0 || to >= this.cis.length) throw new Error('relationship endpoint does not exist: ' + type + ' ' + String(from) + ' -> ' + String(to));
    this.rels.push({ type, from, to, slot: slot.id, attributes });
  }

  get(idx: number): EstateCi {
    const ci = this.cis[idx];
    if (!ci) throw new Error('no CI at index ' + String(idx));
    return ci;
  }

  /** Reference string other CIs use in *Ref identity keys: the value of the first identity key. */
  ref(idx: number): string {
    const ci = this.get(idx);
    const key = CI_IDENTITY_KEYS[ci.type][0];
    const value = key === undefined ? undefined : ci.identity[key];
    if (value === undefined) throw new Error('CI ' + ci.name + ' has no primary identity');
    return value;
  }
}

export interface EstateSummary {
  seed: number;
  scale: number;
  tenantId: string;
  totals: { cis: number; relationships: number; slots: number };
  ciTypes: Record<string, number>;
  layers: Record<string, number>;
  relationshipTypes: Record<string, number>;
  sites: Record<string, number>;
  families: Record<string, { results: number; cis: number; relationships: number }>;
}

export interface Estate {
  seed: number;
  scale: number;
  tenantId: string;
  organization: Organization;
  sites: Site[];
  siteLinks: SiteLink[];
  builder: EstateBuilder;
  services: BusinessServiceRecord[];
}

export interface World {
  b: EstateBuilder;
  rng: Rng;
  sites: SiteWorld[];
  hostPlans: HostPlan[];
}

export function siteByCode(world: World, code: string): SiteWorld {
  const site = world.sites.find((s) => s.def.code === code);
  if (!site) throw new Error('unknown site ' + code);
  return site;
}

export function buildEstate(seed: number, scale: number): Estate {
  if (!(scale > 0)) throw new Error('scale must be positive');
  const root = new Rng(seed);
  const tenantId = root.fork('tenant').uuid();
  const b = new EstateBuilder(seed, scale, tenantId);
  const world: World = { b, rng: root, sites: [], hostPlans: [] };

  // Fork order is fixed so each generator's stream is independent of the others' draw counts.
  const streams = {
    sites: root.fork('sites'),
    plan: root.fork('plan'),
    facilities: root.fork('facilities'),
    network: root.fork('network'),
    hosts: root.fork('hosts'),
    virtualization: root.fork('virtualization'),
    storage: root.fork('storage'),
    kubernetes: root.fork('kubernetes'),
    applications: root.fork('applications'),
    edge: root.fork('edge'),
    cloud: root.fork('cloud'),
    commercial: root.fork('commercial'),
    flows: root.fork('flows'),
  };

  const org = generateSites(world, streams.sites);
  world.hostPlans = planHosts(world, streams.plan);
  generateFacilities(world, streams.facilities);
  generateNetwork(world, streams.network);
  generateHosts(world, streams.hosts);
  generateVirtualization(world, streams.virtualization);
  generateStorage(world, streams.storage);
  generateKubernetes(world, streams.kubernetes);
  const services = generateApplications(world, streams.applications);
  generateEdge(world, streams.edge);
  generateCloud(world, streams.cloud);
  generateCommercial(world, streams.commercial);
  generateFlows(world, streams.flows);

  return { seed, scale, tenantId, organization: org.organization, sites: org.sites, siteLinks: org.siteLinks, builder: b, services };
}

export function summarise(estate: Estate): EstateSummary {
  const { builder } = estate;
  const ciTypes: Record<string, number> = {};
  const layers: Record<string, number> = {};
  const relationshipTypes: Record<string, number> = {};
  const sites: Record<string, number> = {};
  const families: Record<string, { results: number; cis: number; relationships: number }> = {};
  const familyOf = (slotId: number): string => builder.slots[slotId]?.family ?? 'unknown';
  const bump = (rec: Record<string, number>, key: string): void => {
    rec[key] = (rec[key] ?? 0) + 1;
  };
  const familyRec = (family: string): { results: number; cis: number; relationships: number } => {
    const existing = families[family];
    if (existing) return existing;
    const created = { results: 0, cis: 0, relationships: 0 };
    families[family] = created;
    return created;
  };
  for (const ci of builder.cis) {
    bump(ciTypes, ci.type);
    const layer: CiLayer = CI_TYPE_LAYER[ci.type];
    bump(layers, layer);
    bump(sites, ci.siteCode);
    familyRec(familyOf(ci.slot)).cis++;
  }
  for (const rel of builder.rels) {
    bump(relationshipTypes, rel.type);
    familyRec(familyOf(rel.slot)).relationships++;
  }
  for (const slot of builder.slots) familyRec(slot.family).results++;
  return {
    seed: estate.seed,
    scale: estate.scale,
    tenantId: estate.tenantId,
    totals: { cis: builder.cis.length, relationships: builder.rels.length, slots: builder.slots.length },
    ciTypes: sortRecord(ciTypes),
    layers: sortRecord(layers),
    relationshipTypes: sortRecord(relationshipTypes),
    sites: sortRecord(sites),
    families: Object.fromEntries(Object.keys(families).sort().map((k) => [k, families[k] ?? { results: 0, cis: 0, relationships: 0 }])),
  };
}

function sortRecord(rec: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k] ?? 0]));
}

export const SYNTH_BASE = SYNTH_ESTATE;
