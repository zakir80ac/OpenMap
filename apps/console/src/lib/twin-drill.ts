// REQ-UI-037 — the digital twin's drill-down: one CI's neighbours grouped the way an operator reads down from a rack.
// A device's hardware components, the hypervisor and the VMs and containers it runs, its operating system, databases,
// applications, the business services it supports, its network, storage, security and its place in the facility. The
// sections come from the CMDB's relationships (both directions); the services also come from the upstream impact walk,
// so a host shows the services that reach it through its VMs and applications, not only the ones linked directly.
import { queryOptions } from '@tanstack/react-query';
import { CONSOLE } from '@openmap/constants';
import type { HardwareComponent } from './component-queries';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type AffectedService, type CiSummary } from './queries';

/** The order an operator reads down from a device. */
export const DRILL_SECTIONS = [
  'components',
  'compute',
  'os',
  'databases',
  'applications',
  'services',
  'network',
  'storage',
  'security',
  'commercial',
  'place',
  'other',
] as const;
export type DrillSectionKey = (typeof DRILL_SECTIONS)[number];

export interface DrillRelationship {
  id: string;
  type: string;
  from: CiSummary;
  to: CiSummary;
}

export interface DrillVulnerability {
  cveId: string;
  cvss: number;
  severity: string;
  exploited: boolean;
  internetFacing: boolean;
  fixedIn: string | null;
}

export type DrillComponent = Pick<HardwareComponent, 'id' | 'kind' | 'slot' | 'model' | 'manufacturer' | 'capacityBytes'>;

export interface DrillCi extends CiSummary {
  components: DrillComponent[];
  vulnerabilities: DrillVulnerability[];
  relationships: { totalCount: number; edges: Array<{ node: DrillRelationship }> };
}

/** A neighbour in a section: the CI, how it is related (null for a service reached through the graph) and which way. */
export interface DrillItem {
  ci: CiSummary;
  relation: string | null;
  outgoing: boolean;
  /** For a service reached through the graph: the hops between it and the drilled CI. */
  hops: number | null;
}

export interface DrillSection {
  key: DrillSectionKey;
  items: DrillItem[];
}

/** Configuration and findings that guard or expose a CI. */
const SECURITY_TYPES: ReadonlySet<string> = new Set(['firewall_rule', 'firewall_object', 'certificate', 'vulnerability']);
/** The records that say who supplies, supports and licenses a CI: not applications, though the CMDB files them there. */
const COMMERCIAL_TYPES: ReadonlySet<string> = new Set(['vendor', 'contract', 'licence', 'cost_centre']);
/** Hardware that computes, as opposed to the parts and management controllers inside it. */
const COMPUTE_HARDWARE_TYPES: ReadonlySet<string> = new Set(['host', 'blade']);

/** The section a neighbour belongs to, from its type first and its layer otherwise. */
export function sectionOf(ci: Pick<CiSummary, 'type' | 'layer'>): DrillSectionKey {
  if (SECURITY_TYPES.has(ci.type)) return 'security';
  if (ci.type === 'business_service') return 'services';
  if (COMMERCIAL_TYPES.has(ci.type)) return 'commercial';
  switch (ci.layer) {
    case 'hardware':
      return COMPUTE_HARDWARE_TYPES.has(ci.type) ? 'compute' : 'components';
    case 'virtualization':
    case 'containers':
    case 'cloud':
      return 'compute';
    case 'os':
      return 'os';
    case 'databases':
      return 'databases';
    case 'applications':
    case 'saas':
      return 'applications';
    case 'network_security':
      return 'network';
    case 'storage':
      return 'storage';
    case 'dc':
      return 'place';
    default:
      return 'other';
  }
}

/** Down first, then degraded, unknown and healthy; by name within a state. */
const HEALTH_ORDER: readonly string[] = ['down', 'degraded', 'unknown', 'healthy'];

function attentionRank(health: string): number {
  const at = HEALTH_ORDER.indexOf(health);
  return at < 0 ? HEALTH_ORDER.indexOf('unknown') : at;
}

function byAttention(a: DrillItem, b: DrillItem): number {
  const health = attentionRank(a.ci.health) - attentionRank(b.ci.health);
  if (health !== 0) return health;
  const name = a.ci.displayName.localeCompare(b.ci.displayName);
  return name !== 0 ? name : (a.relation ?? '').localeCompare(b.relation ?? '');
}

/**
 * Groups the drilled CI's relationships and the services the upstream walk reached into sections, in DRILL_SECTIONS
 * order, leaving out empty ones. A neighbour related twice the same way appears once; a service linked directly is
 * not repeated from the walk.
 */
export function drillSections(ciId: string, relationships: readonly DrillRelationship[], services: readonly AffectedService[] = []): DrillSection[] {
  const buckets = new Map<DrillSectionKey, DrillItem[]>();
  const seen = new Set<string>();
  const add = (key: DrillSectionKey, item: DrillItem): void => {
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  };
  for (const rel of relationships) {
    const outgoing = rel.from.id === ciId;
    const other = outgoing ? rel.to : rel.from;
    if (other.id === ciId) continue;
    const dedupe = other.id + '|' + rel.type + '|' + String(outgoing);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    add(sectionOf(other), { ci: other, relation: rel.type, outgoing, hops: null });
  }
  const direct = new Set((buckets.get('services') ?? []).map((item) => item.ci.id));
  for (const s of services) {
    if (s.service.id === ciId || direct.has(s.service.id)) continue;
    direct.add(s.service.id);
    add('services', { ci: s.service, relation: null, outgoing: false, hops: Math.max(s.path.length - 1, 1) });
  }
  return DRILL_SECTIONS.flatMap((key) => {
    const items = buckets.get(key);
    return items === undefined || items.length === 0 ? [] : [{ key, items: [...items].sort(byAttention) }];
  });
}

const DRILL_QUERY = [
  'query TwinDrill($id: UUID!, $first: Int) {',
  '  ci(id: $id) {',
  '    ' + CI_SUMMARY_FIELDS,
  '    components { id kind slot model manufacturer capacityBytes }',
  '    vulnerabilities { cveId cvss severity exploited internetFacing fixedIn }',
  '    relationships(first: $first) { totalCount edges { node { id type from { ' + CI_SUMMARY_FIELDS + ' } to { ' + CI_SUMMARY_FIELDS + ' } } } }',
  '  }',
  '}',
].join('\n');

/** One level of the drill-down: the CI with its parts, findings and relationships. */
export function twinDrillQuery(id: string) {
  return queryOptions({
    queryKey: ['twin-drill', id] as const,
    queryFn: ({ signal }) => gql<{ ci: DrillCi | null }>(DRILL_QUERY, { id, first: CONSOLE.relationshipsPageSize }, signal).then((d) => d.ci),
  });
}
