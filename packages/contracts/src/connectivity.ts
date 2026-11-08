// REQ-BSM-007 REQ-UI-026 (ADR-025) — sites and connectivity: the metric names the link_probe collector samples on a
// site_link CI, the traffic and facility measurements the Sites screen reads, the site and link attributes the
// readiness rules and the facility cards read, the link redundancy states, and the shape of a readiness finding.
import { z } from 'zod';

/** Samples a link probe takes, on the link CI (by id): reachable 1/0, median connect round trip, failed share. */
export const LINK_METRICS = {
  reachable: 'net.link.reachable',
  latencyMs: 'net.link.latency_ms',
  lossPercent: 'net.link.loss_percent',
} as const;
export const LINK_METRIC_NAMES = Object.values(LINK_METRICS);

/**
 * REQ-UI-026 — traffic on a site_link CI, from the SNMP or flow collectors that poll the circuit's hand-off interfaces
 * (the network layer's headline measurement, gigabits per second), and the measured PUE of a site, from DCIM
 * telemetry.
 */
export const LINK_TRAFFIC_METRICS = { throughputGbps: 'net.device.throughput_gbps' } as const;
export const SITE_FACILITY_METRICS = { pue: 'dcim.site.pue' } as const;

/**
 * REQ-UI-026 — redundancy between a link's two sites, over every link joining them and each link's diverse paths:
 * - active_active: every path is up, and no link is a backup;
 * - active_standby: every path is up, and a backup link stands by;
 * - degraded: some paths are down, at least one is up;
 * - down: every path is down;
 * - single_path: the two sites have one path, so there is no redundancy to report.
 */
export const LINK_REDUNDANCY_STATES = ['active_active', 'active_standby', 'degraded', 'down', 'single_path'] as const;
export const linkRedundancySchema = z.enum(LINK_REDUNDANCY_STATES);
export type LinkRedundancy = z.infer<typeof linkRedundancySchema>;

/** REQ-UI-026 — site CI attributes the facility card reads; setup (ADR-017) and the synthetic estate write them. */
export const SITE_FACILITY_ATTRIBUTES = {
  kind: 'kind',
  /** Uptime Institute tier, 1 to 4, for data centres and colocation. */
  tier: 'tier',
  powerCapacityKw: 'powerCapacityKw',
  designPue: 'designPue',
} as const;

/** CI types a site's facility tree is made of, outermost first; racks are counted on the card. */
export const SITE_FACILITY_CI_TYPES = ['building', 'room', 'row', 'rack'] as const;

/** A site's part in disaster recovery: the primary site(s), the recovery site, or neither. */
export const SITE_DR_ROLES = ['primary', 'dr', 'none'] as const;
export const siteDrRoleSchema = z.enum(SITE_DR_ROLES);
export type SiteDrRole = z.infer<typeof siteDrRoleSchema>;

/** CI attributes the rules read; the setup wizard and the synthetic estate write them. */
export const CONNECTIVITY_ATTRIBUTES = {
  /** On a site CI: SITE_DR_ROLES. */
  drRole: 'drRole',
  /** On a site CI: business criticality, 1 = most critical. */
  criticality: 'criticality',
  /** On a site_link CI: true when the link carries storage or database replication. */
  replication: 'replication',
  /** On a site_link CI: `host` or `host:port` a Node at the A end connects to. */
  probeTarget: 'probeTarget',
  /** On a site_link CI: physically diverse paths the circuit has. */
  diversePaths: 'diversePaths',
  /** On a site_link CI: latency the provider commits to; above it the link is degraded. */
  slaLatencyMs: 'slaLatencyMs',
  /** On a site_link CI: the circuit's committed bandwidth. */
  bandwidthMbps: 'bandwidthMbps',
  /** On a site_link CI: the two ends' site codes (its identity). */
  fromSiteRef: 'fromSiteRef',
  toSiteRef: 'toSiteRef',
} as const;

/** The readiness rules, each evaluated per subject (a site or a link). */
export const READINESS_RULES = ['diverse_paths', 'dr_reachable', 'replication_healthy'] as const;
export const readinessRuleSchema = z.enum(READINESS_RULES);
export type ReadinessRule = z.infer<typeof readinessRuleSchema>;

export const readinessFindingSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  rule: readinessRuleSchema,
  /** The site or link CI the finding is about. */
  subjectCiId: z.uuid(),
  state: z.enum(['open', 'cleared']),
  detail: z.string().min(1),
  openedAt: z.iso.datetime(),
  clearedAt: z.iso.datetime().nullable(),
  incidentId: z.uuid().nullable(),
});
export type ReadinessFinding = z.infer<typeof readinessFindingSchema>;
