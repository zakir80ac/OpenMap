// REQ-DISC-029 — view types for DiscoveryNode, DiscoveryJob and Sweep.
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
