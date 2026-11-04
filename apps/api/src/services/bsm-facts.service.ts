// REQ-BSM-002 — derives the BSM engine's inputs from the CMDB: redundancy-group service models from
// part_of_service relationships, commercial facts and SLA state from business-service attributes and
// the health-change history, and live health from the graph.
import { Inject, Injectable } from '@nestjs/common';
import { ITSM } from '@openmap/constants';
import type { RelationshipType } from '@openmap/contracts';
import { propagate, slaStatus, type ServiceFacts, type ServiceModel, type SlaStatus } from '@openmap/bsm-engine';
import type { ImpactNode } from '@openmap/graph';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, HealthState } from '../ci/ci.types.js';
import { nowIso } from '../common/time.js';
import { numberAttribute, stringAttribute } from '../common/validation.js';
import { GraphService } from '../db/graph.service.js';
import type { AffectedServiceView, PredictedState } from '../graph/graph.types.js';
import { downtimeMinutes, periodStartFor } from './downtime.js';
import { BSM_REPOSITORY, type BsmRepository } from './services.repository.js';

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
const HEALTH_QUERY = 'UNWIND $ids AS id MATCH (c:Ci {id: id, tenantId: $tenantId}) RETURN c.id AS id, c.health AS health';

export type ConditionSeverity = 'down' | 'degraded' | 'at_risk';

@Injectable()
export class BsmFactsService {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    @Inject(BSM_REPOSITORY) private readonly bsm: BsmRepository,
    private readonly graph: GraphService,
  ) {}

  async healthMap(tenantId: string, ids: readonly string[]): Promise<Map<string, HealthState>> {
    if (ids.length === 0) return new Map();
    const rows = await this.graph.repo.readOnly<{ id: string; health: HealthState | null }>(HEALTH_QUERY, { tenantId, ids: [...ids] });
    return new Map(rows.map((r) => [r.id, r.health ?? 'unknown']));
  }

  /** Redundancy groups per service: members grouped by their `redundancyGroup` attribute, one group per lone member. */
  async modelsFor(tenantId: string, serviceIds: readonly string[]): Promise<Map<string, ServiceModel>> {
    const rels = await this.cis.relationshipsOfMany(tenantId, serviceIds, [PART_OF_SERVICE], 'upstream');
    const members = new Map((await this.cis.findByIds(tenantId, rels.map((r) => r.fromCiId))).map((c) => [c.id, c]));
    const models = new Map<string, ServiceModel>();
    for (const serviceId of serviceIds) {
      const groups = new Map<string, { memberCiIds: string[]; minHealthy: number }>();
      for (const r of rels.filter((x) => x.toCiId === serviceId)) {
        const member = members.get(r.fromCiId);
        if (!member) continue;
        const name = stringAttribute(member.attributes, SERVICE_ATTRIBUTES.redundancyGroup) ?? member.id;
        const group = groups.get(name) ?? { memberCiIds: [], minHealthy: 1 };
        group.memberCiIds.push(member.id);
        group.minHealthy = Math.max(group.minHealthy, numberAttribute(member.attributes, SERVICE_ATTRIBUTES.minHealthy) ?? 1);
        groups.set(name, group);
      }
      models.set(serviceId, { serviceCiId: serviceId, groups: [...groups.entries()].map(([name, g]) => ({ name, ...g })) });
    }
    return models;
  }

  async slaFor(tenantId: string, services: readonly CiRecord[], health: ReadonlyMap<string, HealthState>, now = nowIso()): Promise<Map<string, SlaStatus>> {
    const withSla = services.filter((s) => numberAttribute(s.attributes, SERVICE_ATTRIBUTES.slaTargetPercent) !== null);
    if (withSla.length === 0) return new Map();
    const periodStart = periodStartFor(now);
    const ids = withSla.map((s) => s.id);
    const [events, initial] = await Promise.all([this.bsm.healthEvents(tenantId, ids, periodStart), this.bsm.healthBefore(tenantId, ids, periodStart)]);
    const initialState = new Map(initial.map((e) => [e.subject, e.state]));
    const out = new Map<string, SlaStatus>();
    for (const s of withSla) {
      const target = numberAttribute(s.attributes, SERVICE_ATTRIBUTES.slaTargetPercent) ?? 0;
      const own = events.filter((e) => e.subject === s.id);
      const start = initialState.get(s.id) ?? (own.length === 0 ? (health.get(s.id) ?? 'unknown') : 'healthy');
      out.set(s.id, slaStatus({ targetPercent: target, periodStart, downtimeMinutes: downtimeMinutes(own, start, periodStart, now), now }));
    }
    return out;
  }

  async factsFor(tenantId: string, services: readonly CiRecord[], health: ReadonlyMap<string, HealthState>): Promise<Map<string, ServiceFacts>> {
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
        recovery: recoveryText !== null ? { description: recoveryText, estimatedMinutes: recoveryMinutes ?? 0 } : null,
      });
    }
    return out;
  }

  /**
   * Predicted state of the business services an impact walk reached, assuming `failedIds` take the
   * condition: live health plus the failed components, propagated through each service's groups.
   */
  async predictServices(tenantId: string, reached: readonly ImpactNode[], cis: ReadonlyMap<string, CiRecord>, failedIds: readonly string[], severity: ConditionSeverity): Promise<AffectedServiceView[]> {
    const services = reached.map((n) => cis.get(n.ci.id)).filter((c): c is CiRecord => c !== undefined);
    if (services.length === 0) return [];
    const models = await this.modelsFor(tenantId, services.map((s) => s.id));
    const memberIds = [...models.values()].flatMap((m) => m.groups.flatMap((g) => g.memberCiIds));
    const health = await this.healthMap(tenantId, [...new Set([...memberIds, ...failedIds, ...services.map((s) => s.id)])]);
    const facts = await this.factsFor(tenantId, services, health);
    const hypothetical = new Map(health);
    if (severity !== 'at_risk') for (const id of failedIds) hypothetical.set(id, severity);
    const out: AffectedServiceView[] = [];
    for (const node of reached) {
      const service = cis.get(node.ci.id);
      const f = facts.get(node.ci.id);
      if (!service || !f) continue;
      const model = models.get(service.id);
      const state: HealthState = model && model.groups.length > 0 ? propagate(model, hypothetical).state : severity === 'at_risk' ? 'healthy' : severity;
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
  async healthOf(tenantId: string, service: CiRecord): Promise<{ state: HealthState; rootCauseIds: string[]; sla: SlaStatus | null; slaTarget: number }> {
    const models = await this.modelsFor(tenantId, [service.id]);
    const model = models.get(service.id);
    const memberIds = model ? model.groups.flatMap((g) => g.memberCiIds) : [];
    const health = await this.healthMap(tenantId, [service.id, ...memberIds]);
    const stored = health.get(service.id) ?? 'unknown';
    const propagated = model && model.groups.length > 0 ? propagate(model, health) : null;
    const sla = (await this.slaFor(tenantId, [service], health)).get(service.id) ?? null;
    return {
      state: stored,
      rootCauseIds: propagated ? propagated.rootCauseCiIds : [],
      sla,
      slaTarget: numberAttribute(service.attributes, SERVICE_ATTRIBUTES.slaTargetPercent) ?? 0,
    };
  }
}

export function toPredicted(state: HealthState, severity: ConditionSeverity): PredictedState {
  if (severity === 'at_risk') return 'at_risk';
  if (state === 'down') return 'down';
  if (state === 'degraded' || state === 'unknown') return 'degraded';
  return 'unaffected';
}
