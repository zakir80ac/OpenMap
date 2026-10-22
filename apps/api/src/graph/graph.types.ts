// REQ-DEP-001 — view types for impact, path and layer summaries.
import type { CiLayer } from '@openmap/contracts';
import type { CiRecord } from '../ci/ci.types.js';
import type { Money } from '../common/money.js';

export type PredictedState = 'down' | 'degraded' | 'at_risk' | 'unaffected';

export interface ImpactNodeView {
  ci: CiRecord;
  depth: number;
  predicted: PredictedState;
  path: string[];
}

export interface AffectedServiceView {
  service: CiRecord;
  tier: number;
  predicted: PredictedState;
  path: string[];
  usersAffected: number | null;
  revenueAtRiskPerHour: Money | null;
  slaBudgetRemainingMinutes: number | null;
  recovery: { description: string; estimatedMinutes: number } | null;
}

export interface ImpactResultView {
  root: CiRecord;
  nodes: ImpactNodeView[];
  services: AffectedServiceView[];
  durationMs: number;
}

export interface LayerSummaryView {
  layer: CiLayer;
  count: number;
  healthy: number;
  degraded: number;
  down: number;
  visible: boolean;
}
