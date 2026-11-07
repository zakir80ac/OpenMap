// REQ-BSM-004 (ADR-047) — impact prediction accuracy. Every resolved incident that names a root cause is compared with
// a simulation of that root cause: the latest saved what-if of exactly that component run before the incident opened,
// or else a replay simulation (a scenario of origin `incident`) over the graph as it stands at validation, which the
// sweep runs within a minute of the resolution: the measure is of the model people now rely on. Predicted and
// actual services compare by Jaccard similarity (compareImpact); each service the incident hit that the simulation did
// not reach becomes a relationship suggestion (root cause part_of_service missed service) unless it exists already.
// A sweep runs every IMPACT_VALIDATION_INTERVAL_MS; validateImpactPredictions runs it on demand.
import { Inject, Injectable, Logger, NotFoundException, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { IMPACT } from '@openmap/constants';
import { compareImpact, IMPACTED_STATES, type RelationshipSuggestion, type RelationshipType, type SuggestionState } from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import { CiService, type Actor } from '../ci/ci.service.js';
import { nowIso } from '../common/time.js';
import { ENV, type Env } from '../config/env.module.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { IMPACT_VALIDATION_REPOSITORY, type ImpactValidationRepository, type IncidentToValidate, type ValidationRecord } from './impact-validation.repository.js';
import { IMPACT_REPOSITORY, type ImpactRepository } from './impact.repository.js';
import { ImpactService } from './impact.service.js';
import type { ImpactSimulationView } from './impact.types.js';

export interface ImpactValidationView extends ValidationRecord {
  rootCauseCiId: string;
  unexpectedServiceCiIds: string[];
}

export interface ImpactAccuracyView {
  validated: number;
  meanAccuracy: number | null;
  exact: number;
  pending: number;
  withoutRootCause: number;
  recent: ImpactValidationView[];
}

const SUGGESTION_TYPE: RelationshipType = IMPACT.suggestionType;

/** The services a simulation predicts the incident would hit (down or degraded, not merely at risk). */
export function predictedServiceIds(sim: Pick<ImpactSimulationView, 'services'>): string[] {
  return [...new Set(sim.services.filter((s) => IMPACTED_STATES.includes(s.predicted)).map((s) => s.service.id))];
}

/** Bounds a list length argument to [1, IMPACT.listMax]. */
export function boundedLimit(limit: number | null | undefined, fallback: number): number {
  return Math.max(1, Math.min(limit ?? fallback, IMPACT.listMax));
}

@Injectable()
export class ImpactValidationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ImpactValidationService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(IMPACT_VALIDATION_REPOSITORY) private readonly repo: ImpactValidationRepository,
    @Inject(IMPACT_REPOSITORY) private readonly scenarios: ImpactRepository,
    private readonly impact: ImpactService,
    private readonly cis: CiService,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.env.IMPACT_VALIDATION_INTERVAL_MS;
    if (every === 0) return;
    this.timer = setInterval(() => void this.sweepAll(), every);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /**
   * One sweep over every tenant with incidents to validate, taking one incident of each tenant in turn so a tenant with a
   * large backlog (or a slow graph) does not hold the others back. A sweep still running is not started twice.
   */
  async sweepAll(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let validated = 0;
    try {
      const queues = await Promise.all((await this.repo.tenantsWithPending()).map((tenantId) => this.repo.pending(tenantId, IMPACT.sweepBatch)));
      for (let round = 0; round < IMPACT.sweepBatch; round++) {
        for (const queue of queues) {
          const incident = queue[round];
          if (incident !== undefined && (await this.validateSafely(incident))) validated += 1;
        }
      }
    } catch (err) {
      this.logger.warn('impact validation sweep failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      this.sweeping = false;
    }
    return validated;
  }

  /** Validates up to `limit` of the tenant's oldest unvalidated resolved incidents; returns how many were. */
  async validatePending(tenantId: string, limit: number): Promise<number> {
    let validated = 0;
    for (const incident of await this.repo.pending(tenantId, limit)) if (await this.validateSafely(incident)) validated += 1;
    return validated;
  }

  /** A failed validation is counted and logged; the incident stays pending for the next sweep. */
  private async validateSafely(incident: IncidentToValidate): Promise<boolean> {
    try {
      await this.validate(incident);
      return true;
    } catch (err) {
      this.metrics.impactValidations.inc({ outcome: 'failed' });
      this.logger.warn('impact validation of incident ' + incident.id + ' failed: ' + (err instanceof Error ? err.message : String(err)));
      return false;
    }
  }

  /** Compares one resolved incident with the simulation of its root cause and records the result. */
  async validateIncident(tenantId: string, incidentId: string): Promise<ImpactValidationView> {
    const incident = await this.repo.incident(tenantId, incidentId);
    if (incident === null) throw new NotFoundException('resolved incident ' + incidentId + ' with a root cause not found');
    return this.validate(incident);
  }

  private async validate(incident: IncidentToValidate): Promise<ImpactValidationView> {
    return withSpan(TRACER_NAME, 'impact.validate', { 'openmap.tenant': incident.tenantId, 'openmap.incident': incident.id }, async () => {
      const sim = await this.predictionFor(incident);
      const predicted = predictedServiceIds(sim);
      const actual = [...new Set(incident.affectedServiceCiIds)];
      const { accuracy, missed, unexpected } = compareImpact(predicted, actual);
      const known = await this.repo.existingPairs(incident.tenantId, SUGGESTION_TYPE, incident.rootCauseCiId, missed);
      const record = await this.outbox.transaction(incident.tenantId, async ({ tx, emit }) => {
        const saved = await this.repo.saveValidation(tx, {
          tenantId: incident.tenantId,
          incidentId: incident.id,
          simulationId: sim.id,
          predictedServiceCiIds: predicted,
          actualServiceCiIds: actual,
          missedServiceCiIds: missed,
          accuracy,
          validatedAt: nowIso(),
        });
        for (const serviceId of missed) {
          if (serviceId === incident.rootCauseCiId || known.has(serviceId)) continue;
          await this.repo.suggest(tx, incident.tenantId, SUGGESTION_TYPE, incident.rootCauseCiId, serviceId, incident.id);
        }
        await emit({
          type: 'openmap.audit.action',
          subject: incident.id,
          data: { action: 'impact.validated', incidentId: incident.id, simulationId: sim.id, accuracy, missed, by: IMPACT.replayActor },
        });
        return saved;
      });
      this.metrics.impactValidations.inc({ outcome: accuracy >= 1 ? 'exact' : 'partial' });
      this.metrics.impactAccuracy.observe(accuracy);
      return { ...record, rootCauseCiId: incident.rootCauseCiId, unexpectedServiceCiIds: unexpected };
    });
  }

  /** The person's own prediction when they simulated this root cause before the incident, else a replay. */
  private async predictionFor(incident: IncidentToValidate): Promise<ImpactSimulationView> {
    const prior = await this.repo.priorSimulationId(incident.tenantId, incident.rootCauseCiId, incident.openedAt);
    if (prior !== null) {
      const sim = await this.impact.simulation(incident.tenantId, prior);
      if (sim !== null) return sim;
    }
    const scenario = await this.outbox.transaction(incident.tenantId, ({ tx }) =>
      this.scenarios.saveScenario(tx, incident.tenantId, IMPACT.replayActor, {
        name: incident.title,
        kind: IMPACT.replayKind,
        failedCiIds: [incident.rootCauseCiId],
        maxDepth: IMPACT.replayMaxDepth,
        honourRedundancy: true,
        includeSharedServices: true,
        at: null,
      }, 'incident'),
    );
    return this.impact.runSimulation(incident.tenantId, IMPACT.replayActor, scenario.id);
  }

  async accuracy(tenantId: string, limit: number): Promise<ImpactAccuracyView> {
    const [counts, recent] = await Promise.all([this.repo.counts(tenantId), this.repo.recent(tenantId, limit)]);
    const incidents = new Map<string, string>();
    for (const v of recent) {
      const incident = await this.repo.incident(tenantId, v.incidentId);
      if (incident !== null) incidents.set(v.incidentId, incident.rootCauseCiId);
    }
    return {
      ...counts,
      recent: recent
        .filter((v) => incidents.has(v.incidentId))
        .map((v) => ({ ...v, rootCauseCiId: incidents.get(v.incidentId) ?? '', unexpectedServiceCiIds: compareImpact(v.predictedServiceCiIds, v.actualServiceCiIds).unexpected })),
    };
  }

  suggestions(tenantId: string, state: SuggestionState, limit: number): Promise<RelationshipSuggestion[]> {
    return this.repo.suggestions(tenantId, state, limit);
  }

  /** Creates the suggested relationship (as a person's edit) and records who accepted it. */
  async accept(actor: Actor, id: string): Promise<RelationshipSuggestion> {
    const suggestion = await this.openSuggestion(actor.tenantId, id);
    const rel = await this.cis.createRelationship(actor, suggestion.type, suggestion.fromCiId, suggestion.toCiId, {
      learnedFrom: IMPACT.suggestionReason,
      suggestionId: suggestion.id,
      incidentId: suggestion.lastIncidentId,
    });
    return this.repo.decide(actor.tenantId, id, 'accepted', actor.username, nowIso(), rel.id);
  }

  async dismiss(actor: Actor, id: string): Promise<RelationshipSuggestion> {
    await this.openSuggestion(actor.tenantId, id);
    return this.repo.decide(actor.tenantId, id, 'dismissed', actor.username, nowIso(), null);
  }

  private async openSuggestion(tenantId: string, id: string): Promise<RelationshipSuggestion> {
    const suggestion = await this.repo.suggestion(tenantId, id);
    if (suggestion === null || suggestion.state !== 'open') throw new NotFoundException('open relationship suggestion ' + id + ' not found');
    return suggestion;
  }
}
