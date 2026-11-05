// REQ-BSM-002 REQ-BSM-006 — derives the BSM engine's inputs from the CMDB: redundancy-group service models from
// part_of_service relationships, commercial facts from business-service attributes, SLA state from the assigned SLA
// (or the slaTargetPercent attribute) over its window of the ClickHouse health history (ADR-024), and live health
// from the graph.
import { Inject, Injectable } from '@nestjs/common';
import { BSM, ITSM } from '@openmap/constants';
import type { RelationshipType } from '@openmap/contracts';
import { propagate, type ServiceFacts, type ServiceModel, type SlaStatus } from '@openmap/bsm-engine';
import type { ImpactNode } from '@openmap/graph';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, HealthState } from '../ci/ci.types.js';
import { nowIso } from '../common/time.js';
import { numberAttribute, stringAttribute } from '../common/validation.js';
import { GraphService } from '../db/graph.service.js';
import type { AffectedServiceView, PredictedState } from '../graph/graph.types.js';
import { AvailabilityService } from './availability.service.js';
import { SLA_REPOSITORY, type SlaRepository } from './sla.repository.js';

export const PART_OF_SERVICE: RelationshipType = 'part_of_service';

/** Attribute names on business-service and component CIs that feed the engine. */
export const SERVICE_ATTRIBUTES = {
  tier: 'tier',
  usersAffected: 'usersAffected',
  revenuePerHour: 'revenuePerHour',
  revenueCurrency: 'revenueCurrency',
  slaTargetPercent: 'slaTargetPercent',
  recoveryDescription: 'recoveryDescription',
  recoveryMinutes: 'recoveryMinutes',
  ownerTeams: 'ownerTeams',
  redundancyGroup: 'redundancyGroup',
  minHealthy: 'minHealthy',
} as const;

/** Services without a declared tier are treated as standard tier, the lowest ITSM priority class. */
export const DEFAULT_TIER = ITSM.priorityMedium;

// UNWIND + MATCH by id hits the unique id index once per id; a parameterised `WHERE c.id IN $ids` is evaluated per
// node over the tenant's CIs in Memgraph (1.0 s for 2,400 ids on a 28k-CI tenant against 80 ms, measured over Bolt).
const HEALTH_QUERY =
  'UNWIND $ids AS id MATCH (c:Ci {id: id, tenantId: $tenantId}) RETURN c.id AS id, c.health AS health';

export type ConditionSeverity = 'down' | 'degraded' | 'at_risk';

@Injectable()
export class BsmFactsService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    @Inject(SLA_REPOSITORY) private readonly slas: SlaRepository,
    private readonly availability: AvailabilityService,
    private readonly graph: GraphService,
  ) {}

  async healthMap(tenantId: string, ids: readonly string[]): Promise<Map<string, HealthState>> {
    if (ids.length === 0) return new Map();
    const rows = await this.graph.repo.readOnly<{ id: string; health: HealthState | null }>(HEALTH_QUERY, {
      tenantId,
      ids: [...ids],
    });
    return new Map(rows.map((r) => [r.id, r.health ?? 'unknown']));
  }

  /** Redundancy groups per service: members grouped by their `redundancyGroup` attribute, one group per lone member. */
  async modelsFor(tenantId: string, serviceIds: readonly string[]): Promise<Map<string, ServiceModel>> {
    const rels = await this.cis.relationshipsOfMany(tenantId, serviceIds, [PART_OF_SERVICE], 'upstream');
    const members = new Map(
      (
        await this.cis.findByIds(
          tenantId,
          rels.map((r) => r.fromCiId),
        )
      ).map((c) => [c.id, c]),
    );
    const models = new Map<string, ServiceModel>();
    for (const serviceId of serviceIds) {
      const groups = new Map<string, { memberCiIds: string[]; minHealthy: number }>();
      for (const r of rels.filter((x) => x.toCiId === serviceId)) {
        const member = members.get(r.fromCiId);
        if (!member) continue;
        const name = stringAttribute(member.attributes, SERVICE_ATTRIBUTES.redundancyGroup) ?? member.id;
        const group = groups.get(name) ?? { memberCiIds: [], minHealthy: 1 };
        group.memberCiIds.push(member.id);
        group.minHealthy = Math.max(
          group.minHealthy,
          numberAttribute(member.attributes, SERVICE_ATTRIBUTES.minHealthy) ?? 1,
        );
        groups.set(name, group);
      }
      models.set(serviceId, {
        serviceCiId: serviceId,
        groups: [...groups.entries()].map(([name, g]) => ({ name, ...g })),
      });
    }
    return models;
  }

  /** Error budget of every service with a target (assigned SLA or attribute) over its current window (ADR-024). */
  async slaFor(
    tenantId: string,
    services: readonly CiRecord[],
    health: ReadonlyMap<string, HealthState>,
    now = nowIso(),
  ): Promise<Map<string, SlaStatus>> {
    const slas = await this.slas.assignedTo(
      tenantId,
      services.map((s) => s.id),
    );
    const withTarget = services.filter(
      (s) => AvailabilityService.targetOf(s, slas.get(s.id) ?? null) !== null,
    );
    if (withTarget.length === 0) return new Map();
    const windows = await this.availability.currentWindows(tenantId, withTarget, health, slas, now);
    const out = new Map<string, SlaStatus>();
    for (const s of withTarget) {
      const budget = windows.get(s.id)?.budget;
      if (!budget) continue;
      const consumedPercent =
        budget.budgetMinutes <= 0
          ? BSM.percentScale
          : Math.min(BSM.percentScale, (budget.consumedMinutes / budget.budgetMinutes) * BSM.percentScale);
      out.set(s.id, {
        budgetMinutes: budget.budgetMinutes,
        consumedMinutes: budget.consumedMinutes,
        remainingMinutes: Math.max(0, budget.remainingMinutes),
        consumedPercent,
        burnRate: budget.burnRate,
        breachForecast: null,
        breached: budget.breached,
      });
    }
    return out;
  }

  /** Components whose non-healthy state drives the service's worst redundancy group, from the live health map. */
  async rootCausesOf(
    tenantId: string,
    service: CiRecord,
    health: ReadonlyMap<string, HealthState>,
  ): Promise<string[]> {
    const models = await this.modelsFor(tenantId, [service.id]);
    const model = models.get(service.id);
    if (!model || model.groups.length === 0) return [];
    const memberIds = model.groups.flatMap((g) => g.memberCiIds);
    const missing = memberIds.filter((id) => !health.has(id));
    const full =
      missing.length === 0 ? health : new Map([...health, ...(await this.healthMap(tenantId, missing))]);
    return propagate(model, full).rootCauseCiIds;
  }

  async factsFor(
    tenantId: string,
    services: readonly CiRecord[],
    health: ReadonlyMap<string, HealthState>,
  ): Promise<Map<string, ServiceFacts>> {
    const sla = await this.slaFor(tenantId, services, health);
    const out = new Map<string, ServiceFacts>();
    for (const s of services) {
      const a = s.attributes;
      const revenue = numberAttribute(a, SERVICE_ATTRIBUTES.revenuePerHour);
      const currency = stringAttribute(a, SERVICE_ATTRIBUTES.revenueCurrency);
      const recoveryText = stringAttribute(a, SERVICE_ATTRIBUTES.recoveryDescription);
      const recoveryMinutes = numberAttribute(a, SERVICE_ATTRIBUTES.recoveryMinutes);
      out.set(s.id, {
        serviceCiId: s.id,
        name: s.displayName,
        tier: numberAttribute(a, SERVICE_ATTRIBUTES.tier) ?? DEFAULT_TIER,
        usersAffected: numberAttribute(a, SERVICE_ATTRIBUTES.usersAffected),
        revenuePerHour: revenue !== null && currency !== null ? { amount: revenue, currency } : null,
        sla: sla.get(s.id) ?? null,
        recovery:
          recoveryText !== null
            ? { description: recoveryText, estimatedMinutes: recoveryMinutes ?? 0 }
            : null,
      });
    }
    return out;
  }

  /**
   * Predicted state of the business services an impact walk reached, assuming `failedIds` take the
   * condition: live health plus the failed components, propagated through each service's groups.
   */
  async predictServices(
    tenantId: string,
    reached: readonly ImpactNode[],
    cis: ReadonlyMap<string, CiRecord>,
    failedIds: readonly string[],
    severity: ConditionSeverity,
  ): Promise<AffectedServiceView[]> {
    const services = reached.map((n) => cis.get(n.ci.id)).filter((c): c is CiRecord => c !== undefined);
    if (services.length === 0) return [];
    const models = await this.modelsFor(
      tenantId,
      services.map((s) => s.id),
    );
    const memberIds = [...models.values()].flatMap((m) => m.groups.flatMap((g) => g.memberCiIds));
    const health = await this.healthMap(tenantId, [
      ...new Set([...memberIds, ...failedIds, ...services.map((s) => s.id)]),
    ]);
    const facts = await this.factsFor(tenantId, services, health);
    const hypothetical = new Map(health);
    if (severity !== 'at_risk') for (const id of failedIds) hypothetical.set(id, severity);
    const out: AffectedServiceView[] = [];
    for (const node of reached) {
      const service = cis.get(node.ci.id);
      const f = facts.get(node.ci.id);
      if (!service || !f) continue;
      const model = models.get(service.id);
      const state: HealthState =
        model && model.groups.length > 0
          ? propagate(model, hypothetical).state
          : severity === 'at_risk'
            ? 'healthy'
            : severity;
      const predicted = toPredicted(state, severity);
      out.push({
        service,
        tier: f.tier,
        predicted,
        path: node.path,
        usersAffected: predicted === 'unaffected' ? 0 : f.usersAffected,
        revenueAtRiskPerHour: f.revenuePerHour,
        slaBudgetRemainingMinutes: f.sla ? f.sla.remainingMinutes : null,
        recovery: f.recovery,
      });
    }
    return out;
  }

  /** Current state, root causes and SLA budget of one business service from stored states. */
  async healthOf(
    tenantId: string,
    service: CiRecord,
  ): Promise<{ state: HealthState; rootCauseIds: string[]; sla: SlaStatus | null; slaTarget: number }> {
    const models = await this.modelsFor(tenantId, [service.id]);
    const model = models.get(service.id);
    const memberIds = model ? model.groups.flatMap((g) => g.memberCiIds) : [];
    const health = await this.healthMap(tenantId, [service.id, ...memberIds]);
    const stored = health.get(service.id) ?? 'unknown';
    const propagated = model && model.groups.length > 0 ? propagate(model, health) : null;
    const slas = await this.slas.assignedTo(tenantId, [service.id]);
    const sla = (await this.slaFor(tenantId, [service], health)).get(service.id) ?? null;
    return {
      state: stored,
      rootCauseIds: propagated ? propagated.rootCauseCiIds : [],
      sla,
      slaTarget: AvailabilityService.targetOf(service, slas.get(service.id) ?? null) ?? 0,
    };
  }
}

export function toPredicted(state: HealthState, severity: ConditionSeverity): PredictedState {
  if (severity === 'at_risk') return 'at_risk';
  if (state === 'down') return 'down';
  if (state === 'degraded' || state === 'unknown') return 'degraded';
  return 'unaffected';
}
