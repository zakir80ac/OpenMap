// REQ-UI-030 — view shapes the dashboard resolvers return (ADR-020).
import type { AssetStage, Dashboard, PLAN_STATUSES } from '@openmap/contracts';

type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface DashboardView extends Dashboard {
  /** True when the signed-in user owns it; the console shows edit controls only then. */
  mine: boolean;
}

export interface MoneyTotal {
  amount: number;
  currency: string;
}

export interface StageCountView {
  stage: AssetStage;
  count: number;
  purchaseCost: MoneyTotal[];
}

export interface LicenceStatsView {
  products: number;
  licensed: number;
  overDeployed: number;
  expiringSoon: number;
  expired: number;
  annualCost: MoneyTotal[];
}

export interface VulnerabilityStatsView {
  total: number;
  critical: number;
  exploited: number;
  cisaKev: number;
  internetFacing: number;
  patchAvailable: number;
  affectedHosts: number;
}

export interface PlanStatusCostView {
  status: PlanStatus;
  count: number;
  estimatedCost: MoneyTotal[];
}

export interface EstateTrendView {
  days: string[];
  cis: number[];
  discoveryRuns: number[];
  events: number[];
  incidents: number[];
}

export interface EstateStatsView {
  assetsByStage: StageCountView[];
  licences: LicenceStatsView;
  vulnerabilities: VulnerabilityStatsView;
  endOfSupport: number;
  plans: PlanStatusCostView[];
  power: { racks: number; ratedWatts: number; currentWatts: number };
  ipam: { subnets: number; averageUtilisationPercent: number; critical: number };
  nodes: { total: number; online: number };
  integrations: { total: number; healthy: number; failedLastHour: number };
  incidentsOpen: number;
  trend: EstateTrendView;
}
