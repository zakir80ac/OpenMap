// REQ-BSM-003 REQ-BSM-004 — impact modeling contract: "what if" scenarios simulated over the dependency graph.
// A scenario names failed components; a simulation returns every service it touches with
// predicted state, SLA effect and a recovery path. Accuracy is measured against real incidents (ADR-047): each
// resolved incident with a root cause is compared with a simulation of that root cause, and every service the
// incident hit that the simulation missed becomes a relationship suggestion (root cause part_of_service missed
// service) for a person to accept or dismiss.
import { z } from 'zod';
import { relationshipTypeSchema } from './ci.js';

/**
 * Who a scenario is for (ADR-047): `user` scenarios are the what-if models people save; `incident` scenarios replay
 * a real incident's root cause to measure the prediction, and stay out of the saved list.
 */
export const SCENARIO_ORIGINS = ['user', 'incident'] as const;
export const scenarioOriginSchema = z.enum(SCENARIO_ORIGINS);
export type ScenarioOrigin = z.infer<typeof scenarioOriginSchema>;

/**
 * What the scenario assumes happens to its components (ADR-019). The kinds are the conditions the console offers;
 * each starts the failed components in the predicted state the engine propagates from: `down` kinds take every
 * dependant without redundancy down, `degraded` kinds degrade them, `at_risk` kinds leave live state alone and flag
 * the services as at risk.
 */
export const SCENARIO_KINDS = [
  'failed',
  'degraded',
  'power_loss',
  'link_down',
  'certificate_expired',
  'warranty_expired',
  'subscription_expired',
  'end_of_life',
  'vulnerability_exploited',
  'capacity_exhausted',
  'maintenance',
] as const;
export const scenarioKindSchema = z.enum(SCENARIO_KINDS);
export type ScenarioKind = z.infer<typeof scenarioKindSchema>;

export const SCENARIO_SEVERITIES = ['down', 'degraded', 'at_risk'] as const;
export type ScenarioSeverity = (typeof SCENARIO_SEVERITIES)[number];

/** The state a kind puts its failed components in; one entry per kind, checked at compile time. */
export const SCENARIO_KIND_SEVERITY: Record<ScenarioKind, ScenarioSeverity> = {
  failed: 'down',
  degraded: 'degraded',
  power_loss: 'down',
  link_down: 'down',
  certificate_expired: 'down',
  warranty_expired: 'at_risk',
  subscription_expired: 'at_risk',
  end_of_life: 'at_risk',
  vulnerability_exploited: 'degraded',
  capacity_exhausted: 'degraded',
  maintenance: 'degraded',
};

/** A runbook: numbered steps with an optional automation hook (SOAR playbook or Ansible job) per step. */
export const runbookSchema = z.object({
  code: z.string().min(1),
  title: z.string().min(1),
  steps: z
    .array(
      z.object({
        order: z.number().int().positive(),
        instruction: z.string().min(1),
        /** Integration id and playbook/job name that performs this step automatically, if any. */
        automation: z.object({ integrationId: z.uuid(), action: z.string().min(1) }).nullable(),
        /** Expected completion time for the step, used to estimate total recovery. */
        estimatedMinutes: z.number().int().min(0).nullable(),
      }),
    )
    .min(1),
  ownerTeam: z.string().min(1),
  lastReviewedAt: z.iso.date().nullable(),
});
export type Runbook = z.infer<typeof runbookSchema>;

export const impactScenarioSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  name: z.string().min(1),
  kind: scenarioKindSchema,
  origin: scenarioOriginSchema,
  /** CIs the condition is applied to; the simulation expands over their upstream closure at run time. */
  failedCiIds: z.array(z.uuid()).min(1),
  options: z.object({
    /** 0 means unlimited. */
    maxDepth: z.number().int().min(0),
    honourRedundancy: z.boolean(),
    includeSharedServices: z.boolean(),
    /** ISO time the scenario is evaluated at; load profiles differ by hour. */
    at: z.iso.datetime().nullable(),
  }),
  createdBy: z.string().min(1),
  createdAt: z.iso.datetime(),
  /** Optional link to a planned change in the ITSM so the simulation attaches to it. */
  changeRef: z.object({ source: z.string().min(1), id: z.string().min(1) }).nullable(),
  /** Standard operating procedure to follow if this scenario happens for real. */
  runbook: runbookSchema.nullable(),
});
export type ImpactScenario = z.infer<typeof impactScenarioSchema>;

export const PREDICTED_STATES = ['down', 'degraded', 'at_risk', 'unaffected'] as const;

export const affectedServiceSchema = z.object({
  serviceCiId: z.uuid(),
  name: z.string().min(1),
  tier: z.number().int().min(1),
  predicted: z.enum(PREDICTED_STATES),
  /** Shortest failure path from a failed component to the service. */
  path: z.array(z.uuid()),
  usersAffected: z.number().int().min(0).nullable(),
  revenueAtRiskPerHour: z.object({ amount: z.number().min(0), currency: z.string().length(3) }).nullable(),
  /** Minutes of SLA error budget left after the predicted outage duration. */
  slaBudgetRemainingMinutes: z.number().nullable(),
  recovery: z.object({ description: z.string().min(1), estimatedMinutes: z.number().int().min(0) }).nullable(),
});

export const impactSimulationSchema = z.object({
  id: z.uuid(),
  scenarioId: z.uuid(),
  tenantId: z.uuid(),
  ranAt: z.iso.datetime(),
  durationMs: z.number().int().min(0),
  /** Components that end up failed after expansion and redundancy evaluation. */
  failedCiIds: z.array(z.uuid()),
  affectedApplicationCiIds: z.array(z.uuid()),
  services: z.array(affectedServiceSchema),
  totals: z.object({
    servicesDown: z.number().int().min(0),
    servicesDegraded: z.number().int().min(0),
    usersAffected: z.number().int().min(0),
    revenueAtRiskPerHour: z.object({ amount: z.number().min(0), currency: z.string().length(3) }).nullable(),
  }),
  recommendations: z.array(
    z.object({ title: z.string().min(1), rationale: z.string().min(1), estimatedMinutes: z.number().int().min(0).nullable() }),
  ),
});
export type ImpactSimulation = z.infer<typeof impactSimulationSchema>;

/** Comparison of a simulation with a real incident, used to report prediction accuracy and learn missing edges. */
export const impactValidationSchema = z.object({
  simulationId: z.uuid(),
  incidentId: z.uuid(),
  predictedServiceCiIds: z.array(z.uuid()),
  actualServiceCiIds: z.array(z.uuid()),
  /** Jaccard similarity of predicted vs actual, 0..1. */
  accuracy: z.number().min(0).max(1),
  missedServiceCiIds: z.array(z.uuid()),
  validatedAt: z.iso.datetime(),
});
export type ImpactValidation = z.infer<typeof impactValidationSchema>;

/** Predicted states that count as "the incident hit this service": an at-risk service kept running. */
export const IMPACTED_STATES: ReadonlyArray<(typeof PREDICTED_STATES)[number]> = ['down', 'degraded'];

/**
 * Predicted against actual services (ADR-047). Accuracy is the Jaccard similarity of the two sets; two empty sets
 * agree. `missed` is what the incident hit that the model did not predict (the dependency the graph lacks);
 * `unexpected` is what the model predicted that the incident spared (redundancy the model does not know about).
 */
export function compareImpact(
  predicted: readonly string[],
  actual: readonly string[],
): { accuracy: number; missed: string[]; unexpected: string[] } {
  const p = new Set(predicted);
  const a = new Set(actual);
  const union = new Set([...p, ...a]);
  if (union.size === 0) return { accuracy: 1, missed: [], unexpected: [] };
  const both = [...p].filter((id) => a.has(id)).length;
  return {
    accuracy: both / union.size,
    missed: [...a].filter((id) => !p.has(id)).sort(),
    unexpected: [...p].filter((id) => !a.has(id)).sort(),
  };
}

export const SUGGESTION_STATES = ['open', 'accepted', 'dismissed'] as const;
export const suggestionStateSchema = z.enum(SUGGESTION_STATES);
export type SuggestionState = z.infer<typeof suggestionStateSchema>;

/** Why a relationship is suggested; `impact_miss`: an incident hit the service and no modelled path reached it. */
export const SUGGESTION_REASONS = ['impact_miss'] as const;

/**
 * A relationship the graph may be missing (ADR-047): `fromCiId` (the incident's root cause) `type` `toCiId` (the
 * service it hit that no modelled path reached), `part_of_service`, the edge the impact traversal follows into
 * services. Repeated misses add to `occurrences`; accepting creates the relationship, so the next failure of that
 * root cause predicts the service; dismissing keeps the row so the same miss is not suggested again.
 */
export const relationshipSuggestionSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  type: relationshipTypeSchema,
  fromCiId: z.uuid(),
  toCiId: z.uuid(),
  reason: z.enum(SUGGESTION_REASONS),
  occurrences: z.number().int().min(1),
  lastIncidentId: z.uuid().nullable(),
  state: suggestionStateSchema,
  decidedBy: z.string().min(1).nullable(),
  decidedAt: z.iso.datetime().nullable(),
  relationshipId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RelationshipSuggestion = z.infer<typeof relationshipSuggestionSchema>;
