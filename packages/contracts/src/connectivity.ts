// REQ-BSM-007 (ADR-025) — sites and connectivity: the metric names the link_probe collector samples on a site_link
// CI, the site and link attributes the readiness rules read, and the shape of a readiness finding.
import { z } from 'zod';

/** Samples a link probe takes, on the link CI (by id): reachable 1/0, median connect round trip, failed share. */
export const LINK_METRICS = {
  reachable: 'net.link.reachable',
  latencyMs: 'net.link.latency_ms',
  lossPercent: 'net.link.loss_percent',
} as const;
export const LINK_METRIC_NAMES = Object.values(LINK_METRICS);

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
