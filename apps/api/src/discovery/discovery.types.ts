// REQ-DISC-029 — view types for DiscoveryNode, DiscoveryJob, Sweep and DiscoveryScope.
export interface DiscoveryNodeView {
  id: string;
  siteId: string;
  siteCiId: string | null;
  status: string;
  lastHeartbeat: string;
  activeJobs: number;
  certificateExpiresAt: string;
  collectorIds: string[];
}

export interface DiscoveryJobView {
  id: string;
  collectorId: string;
  nodeId: string;
  status: string;
  targets: number;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cisEmitted: number;
  errors: number;
  sweepId: string | null;
}

export interface SweepView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  targetsTotal: number;
  targetsDone: number;
  devicesDiscovered: number;
  budgetMinutes: number;
}

/** A subnet CI as a discovery scope (ADR-015): CIDR from the identity (legacy rows: attributes), the rest from attributes. */
export interface DiscoveryScopeView {
  ciId: string;
  cidr: string;
  siteCiId: string | null;
  exclusions: string[];
  credentialRef: string | null;
  credentialType: string;
  rateLimitConcurrency: number | null;
  rateLimitRps: number | null;
}

export interface DiscoveryScopeInput {
  exclusions?: string[] | null | undefined;
  credentialRef?: string | null | undefined;
  credentialType?: string | null | undefined;
  rateLimitConcurrency?: number | null | undefined;
  rateLimitRps?: number | null | undefined;
}
