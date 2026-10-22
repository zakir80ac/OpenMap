// REQ-BSM-003 — impact simulation: applies a scenario's condition to the graph's upstream closure and
// predicts each business service's state through the redundancy-aware propagation rules.
import { BSM } from '@openmap/constants';
import type { ImpactScenario, ImpactSimulation } from '@openmap/contracts';
import type { GraphRepository, ImpactNode } from '@openmap/graph';
import { propagate, type Health, type ServiceModel } from './propagate.js';
import { remainingAfterOutage, type SlaStatus } from './sla.js';

/** How a condition lands on the component it is applied to. `at_risk` leaves the graph state unchanged. */
export type ConditionSeverity = 'down' | 'degraded' | 'at_risk';

export interface ServiceFacts {
  serviceCiId: string;
  name: string;
  tier: number;
  usersAffected: number | null;
  revenuePerHour: { amount: number; currency: string } | null;
  sla: SlaStatus | null;
  /** Recovery estimate supplied by the service owner or the runbook catalogue. */
  recovery: { description: string; estimatedMinutes: number } | null;
}

export interface SimulationInputs {
  scenario: ImpactScenario;
  severity: ConditionSeverity;
  /** Current health of every CI the closure may touch. */
  health: ReadonlyMap<string, Health>;
  models: ReadonlyMap<string, ServiceModel>;
  facts: ReadonlyMap<string, ServiceFacts>;
  /** Expected outage duration for SLA arithmetic, minutes. */
  outageMinutes: number;
}

function predicted(state: Health, severity: ConditionSeverity): ImpactSimulation['services'][number]['predicted'] {
  if (severity === 'at_risk') return 'at_risk';
  if (state === 'down') return 'down';
  if (state === 'degraded' || state === 'unknown') return 'degraded';
  return 'unaffected';
}

export async function simulate(repo: GraphRepository, inputs: SimulationInputs, now: () => string = () => new Date().toISOString()): Promise<ImpactSimulation> {
  const started = Date.now();
  const { scenario, severity } = inputs;
  const closure = new Map<string, ImpactNode>();
  const serviceIds = new Set<string>();
  for (const rootId of scenario.failedCiIds) {
    const result = await repo.impact(scenario.tenantId, rootId, { direction: 'upstream', maxDepth: scenario.options.maxDepth, asOf: scenario.options.at, edgeTypes: [] });
    for (const n of result.nodes) if (!closure.has(n.ci.id)) closure.set(n.ci.id, n);
    for (const s of result.services) serviceIds.add(s.ci.id);
  }
  // Hypothetical health: failed components take the condition; everything else keeps its live state.
  const hypothetical = new Map(inputs.health);
  if (severity !== 'at_risk') for (const id of scenario.failedCiIds) hypothetical.set(id, severity);
  // Components in the closure that only reach the failed set through a single path inherit the state
  // when redundancy is not honoured; when honoured, the service models decide.
  if (!scenario.options.honourRedundancy && severity !== 'at_risk') for (const id of closure.keys()) hypothetical.set(id, severity);

  const services: ImpactSimulation['services'] = [];
  for (const serviceId of serviceIds) {
    const model = inputs.models.get(serviceId);
    const facts = inputs.facts.get(serviceId);
    const node = closure.get(serviceId);
    if (!facts || !node) continue;
    const direct: Health = severity === 'at_risk' ? 'healthy' : severity;
    const state: Health = scenario.options.honourRedundancy && model ? propagate(model, hypothetical).state : direct;
    const p = predicted(state, severity);
    const slaRemaining = facts.sla && p === 'down' ? remainingAfterOutage(facts.sla, inputs.outageMinutes) : facts.sla ? facts.sla.remainingMinutes : null;
    services.push({
      serviceCiId: serviceId,
      name: facts.name,
      tier: facts.tier,
      predicted: p,
      path: node.path,
      usersAffected: p === 'unaffected' ? 0 : facts.usersAffected,
      revenueAtRiskPerHour: facts.revenuePerHour,
      slaBudgetRemainingMinutes: slaRemaining,
      recovery: facts.recovery,
    });
  }
  services.sort((a, b) => rank(a.predicted) - rank(b.predicted) || a.tier - b.tier);

  const down = services.filter((s) => s.predicted === 'down');
  const degraded = services.filter((s) => s.predicted === 'degraded');
  const currency = services.find((s) => s.revenueAtRiskPerHour)?.revenueAtRiskPerHour?.currency ?? null;
  const revenue = down.reduce((a, s) => a + (s.revenueAtRiskPerHour?.amount ?? 0), 0) + degraded.reduce((a, s) => a + (s.revenueAtRiskPerHour?.amount ?? 0) * BSM.degradedRevenueFactor, 0);
  return {
    id: cryptoId(),
    scenarioId: scenario.id,
    tenantId: scenario.tenantId,
    ranAt: now(),
    durationMs: Date.now() - started,
    failedCiIds: [...scenario.failedCiIds],
    affectedApplicationCiIds: [...closure.values()].filter((n) => n.ci.type === 'application' || n.ci.type === 'application_component').map((n) => n.ci.id),
    services,
    totals: {
      servicesDown: down.length,
      servicesDegraded: degraded.length,
      usersAffected: services.reduce((a, s) => a + (s.predicted === 'unaffected' || s.predicted === 'at_risk' ? 0 : (s.usersAffected ?? 0)), 0),
      revenueAtRiskPerHour: currency ? { amount: Math.round(revenue), currency } : null,
    },
    recommendations: [],
  };
}

function rank(p: ImpactSimulation['services'][number]['predicted']): number {
  return BSM.predictedOrder.indexOf(p);
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID();
}
