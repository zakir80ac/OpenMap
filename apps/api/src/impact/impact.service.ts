// REQ-BSM-003 — impact modelling use cases: save scenarios and run them through the BSM engine's
// simulate() with service models, facts and live health loaded from the CMDB and the graph.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { simulate, type ConditionSeverity } from '@openmap/bsm-engine';
import { SCENARIO_KIND_SEVERITY } from '@openmap/contracts';
import type { ImpactScenario, ImpactSimulation } from '@openmap/contracts';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { GraphService } from '../db/graph.service.js';
import type { AffectedServiceView } from '../graph/graph.types.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { BsmFactsService } from '../services/bsm-facts.service.js';
import { IMPACT_REPOSITORY, type ImpactRepository } from './impact.repository.js';
import type { ScenarioInput } from './impact.schemas.js';
import type { ImpactScenarioView, ImpactSimulationView } from './impact.types.js';

/** The state a scenario kind starts its components in, from the contract's kind table (ADR-019). */
export function severityFor(kind: ImpactScenario['kind']): ConditionSeverity {
  return SCENARIO_KIND_SEVERITY[kind];
}

export function toScenarioView(s: ImpactScenario): ImpactScenarioView {
  return { id: s.id, name: s.name, kind: s.kind, origin: s.origin, failedCiIds: s.failedCiIds, options: s.options, createdBy: s.createdBy, createdAt: s.createdAt };
}

@Injectable()
export class ImpactService {
  constructor(
    @Inject(IMPACT_REPOSITORY) private readonly repo: ImpactRepository,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly graph: GraphService,
    private readonly facts: BsmFactsService,
    private readonly outbox: OutboxService,
  ) {}

  async scenarios(tenantId: string): Promise<ImpactScenarioView[]> {
    return (await this.repo.scenarios(tenantId)).map(toScenarioView);
  }

  async scenario(tenantId: string, id: string): Promise<ImpactScenarioView> {
    const s = await this.repo.scenario(tenantId, id);
    if (!s) throw new NotFoundException('scenario ' + id + ' not found');
    return toScenarioView(s);
  }

  async simulation(tenantId: string, id: string): Promise<ImpactSimulationView | null> {
    const sim = await this.repo.simulation(tenantId, id);
    return sim ? this.toView(tenantId, sim) : null;
  }

  saveScenario(tenantId: string, createdBy: string, input: ScenarioInput): Promise<ImpactScenarioView> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const scenario = await this.repo.saveScenario(tx, tenantId, createdBy, input);
      await emit({ type: 'openmap.audit.action', subject: scenario.id, data: { action: 'impact.scenario.saved', scenarioId: scenario.id, kind: scenario.kind, failedCiIds: scenario.failedCiIds, by: createdBy } });
      return toScenarioView(scenario);
    });
  }

  async runSimulation(tenantId: string, actor: string, scenarioId: string): Promise<ImpactSimulationView> {
    const scenario = await this.repo.scenario(tenantId, scenarioId);
    if (!scenario) throw new NotFoundException('scenario ' + scenarioId + ' not found');
    const severity = severityFor(scenario.kind);
    // First pass over the closure to learn which services and components the simulation will touch.
    const closureIds = new Set<string>(scenario.failedCiIds);
    const serviceIds = new Set<string>();
    for (const rootId of scenario.failedCiIds) {
      const r = await this.graph.repo.impact(tenantId, rootId, { direction: 'upstream', maxDepth: scenario.options.maxDepth, asOf: scenario.options.at, edgeTypes: [] });
      for (const n of r.nodes) closureIds.add(n.ci.id);
      for (const s of r.services) serviceIds.add(s.ci.id);
    }
    const services = (await this.cis.findByIds(tenantId, [...serviceIds])).filter((c) => c.type === 'business_service');
    const models = await this.facts.modelsFor(tenantId, services.map((s) => s.id));
    const memberIds = [...models.values()].flatMap((m) => m.groups.flatMap((g) => g.memberCiIds));
    const health = await this.facts.healthMap(tenantId, [...new Set([...closureIds, ...memberIds, ...services.map((s) => s.id)])]);
    const facts = await this.facts.factsFor(tenantId, services, health);
    const outageMinutes = Math.max(0, ...[...facts.values()].map((f) => f.recovery?.estimatedMinutes ?? 0));
    const result = await simulate(this.graph.repo, { scenario, severity, health, models, facts, outageMinutes });
    result.recommendations = recommendationsFor(result, models);
    const saved = await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const sim = await this.repo.saveSimulation(tx, result);
      await emit({
        type: 'openmap.impact.simulation.completed',
        subject: sim.scenarioId,
        data: { simulationId: sim.id, scenarioId: sim.scenarioId, servicesDown: sim.totals.servicesDown, servicesDegraded: sim.totals.servicesDegraded, usersAffected: sim.totals.usersAffected, durationMs: sim.durationMs, by: actor },
      });
      return sim;
    });
    return this.toView(tenantId, saved);
  }

  private async toView(tenantId: string, sim: ImpactSimulation): Promise<ImpactSimulationView> {
    const cis = new Map((await this.cis.findByIds(tenantId, sim.services.map((s) => s.serviceCiId))).map((c) => [c.id, c]));
    const services: AffectedServiceView[] = [];
    for (const s of sim.services) {
      const service = cis.get(s.serviceCiId);
      if (!service) continue;
      services.push({ service, tier: s.tier, predicted: s.predicted, path: s.path, usersAffected: s.usersAffected, revenueAtRiskPerHour: s.revenueAtRiskPerHour, slaBudgetRemainingMinutes: s.slaBudgetRemainingMinutes, recovery: s.recovery });
    }
    return {
      id: sim.id,
      scenarioId: sim.scenarioId,
      ranAt: sim.ranAt,
      durationMs: sim.durationMs,
      failedCiIds: sim.failedCiIds,
      affectedApplicationCiIds: sim.affectedApplicationCiIds,
      services,
      totals: sim.totals,
      recommendations: sim.recommendations,
    };
  }

  cisByIds(tenantId: string, ids: readonly string[]): Promise<CiRecord[]> {
    return this.cis.findByIds(tenantId, ids);
  }
}

/** Recovery steps for services predicted down, and a redundancy recommendation where no group model protects them. */
export function recommendationsFor(sim: ImpactSimulation, models: ReadonlyMap<string, { groups: readonly unknown[] }>): ImpactSimulation['recommendations'] {
  const out: ImpactSimulation['recommendations'] = [];
  for (const s of sim.services) {
    if (s.predicted !== 'down' && s.predicted !== 'degraded') continue;
    if (s.recovery) out.push({ title: 'Recover ' + s.name, rationale: s.recovery.description, estimatedMinutes: s.recovery.estimatedMinutes });
    const model = models.get(s.serviceCiId);
    if (!model || model.groups.length === 0) {
      out.push({ title: 'Model redundancy for ' + s.name, rationale: 'No redundancy groups are declared for this service, so any failed dependency is predicted to take it down.', estimatedMinutes: null });
    }
  }
  return out;
}
