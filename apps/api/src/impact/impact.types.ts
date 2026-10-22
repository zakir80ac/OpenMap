// REQ-BSM-003 — view types for ImpactScenario and ImpactSimulation.
import type { ImpactScenario, ImpactSimulation } from '@openmap/contracts';
import type { Money } from '../common/money.js';
import type { AffectedServiceView } from '../graph/graph.types.js';

export interface ImpactScenarioView {
  id: string;
  name: string;
  kind: ImpactScenario['kind'];
  failedCiIds: string[];
  options: ImpactScenario['options'];
  createdBy: string;
  createdAt: string;
}

export interface ImpactSimulationView {
  id: string;
  scenarioId: string;
  ranAt: string;
  durationMs: number;
  failedCiIds: string[];
  affectedApplicationCiIds: string[];
  services: AffectedServiceView[];
  totals: { servicesDown: number; servicesDegraded: number; usersAffected: number; revenueAtRiskPerHour: Money | null };
  recommendations: ImpactSimulation['recommendations'];
}
