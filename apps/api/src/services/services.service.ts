// REQ-BSM-002 REQ-BSM-006 REQ-BSM-008 — business service management use cases (ADR-024): service health with the SLA
// and its current window, incidents and their response (acknowledge, assign, resolve, close, RCA) with every step
// audited, the SLA catalogue and assignment, availability by month, quarter and year with CSV export, and reporting an
// incident to an ITSM or SIEM integration.
import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { deliver, type IncidentView } from '@openmap/bsm-engine';
import { PERF_BUDGETS, type AvailabilityGranularity } from '@openmap/constants';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, HealthState } from '../ci/ci.types.js';
import { nowIso } from '../common/time.js';
import { stringArrayAttribute } from '../common/validation.js';
import {
  INTEGRATIONS_REPOSITORY,
  type IntegrationsRepository,
} from '../integrations/integrations.repository.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { AvailabilityService } from './availability.service.js';
import { BsmFactsService, SERVICE_ATTRIBUTES } from './bsm-facts.service.js';
import { incidentRequest, remoteUrlFor } from './incident-delivery.js';
import { SLA_REPOSITORY, type SlaRepository } from './sla.repository.js';
import type { RcaInput, SlaInput } from './services.schemas.js';
import { BSM_REPOSITORY, HEALTH_CHANGED, type BsmRepository } from './services.repository.js';
import type {
  AvailabilityPeriodView,
  IncidentEventView,
  IncidentLinkRecord,
  IncidentRecord,
  ServiceAvailabilityView,
  ServiceHealthView,
  SlaRecord,
} from './services.types.js';

/** Retry back-off inside a request is capped at the impact-query budget; dead letters are redelivered by the reconciler. */
export const IN_REQUEST_BACKOFF_CAP_MS = PERF_BUDGETS.impactQuery100kP95Ms;
const SERVICE_TYPE = 'business_service';
const INCIDENT_UPDATED = 'openmap.incident.updated';
const INCIDENT_RESOLVED = 'openmap.incident.resolved';
const SLA_CHANGED = 'openmap.audit.action';

@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);

  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    @Inject(BSM_REPOSITORY) private readonly bsm: BsmRepository,
    @Inject(SLA_REPOSITORY) private readonly slaRepo: SlaRepository,
    @Inject(INTEGRATIONS_REPOSITORY) private readonly integrationsRepo: IntegrationsRepository,
    private readonly integrations: IntegrationsService,
    private readonly secrets: SecretsService,
    private readonly facts: BsmFactsService,
    private readonly availability: AvailabilityService,
    private readonly outbox: OutboxService,
  ) {}

  async services(tenantId: string, states: readonly HealthState[] | null): Promise<ServiceHealthView[]> {
    const services = await this.cis.byType(tenantId, SERVICE_TYPE);
    const views = await this.healthViews(tenantId, services);
    return states === null || states.length === 0 ? views : views.filter((v) => states.includes(v.state));
  }

  async healthViewById(tenantId: string, serviceId: string): Promise<ServiceHealthView | null> {
    const service = await this.cis.findById(tenantId, serviceId, null);
    if (!service || service.type !== SERVICE_TYPE) return null;
    const [view] = await this.healthViews(tenantId, [service]);
    return view ?? null;
  }

  /** One round trip per store for the whole list: live health, SLAs, the current windows, the last change. */
  async healthViews(tenantId: string, services: readonly CiRecord[]): Promise<ServiceHealthView[]> {
    if (services.length === 0) return [];
    const ids = services.map((s) => s.id);
    const [health, slas, lastChanges] = await Promise.all([
      this.facts.healthMap(tenantId, ids),
      this.slaRepo.assignedTo(tenantId, ids),
      this.availability.lastChanges(tenantId, ids),
    ]);
    const windows = await this.availability.currentWindows(tenantId, services, health, slas);
    const rootCauseIds = new Map<string, string[]>();
    for (const service of services)
      rootCauseIds.set(service.id, await this.facts.rootCausesOf(tenantId, service, health));
    const causes = await this.cis.findByIds(tenantId, [...new Set([...rootCauseIds.values()].flat())]);
    const causeById = new Map(causes.map((c) => [c.id, c]));
    return services.map((service) => {
      const window = windows.get(service.id);
      const sla = slas.get(service.id) ?? null;
      return {
        service,
        state: health.get(service.id) ?? 'unknown',
        since: lastChanges.get(service.id) ?? service.validFrom,
        rootCauses: (rootCauseIds.get(service.id) ?? [])
          .map((id) => causeById.get(id))
          .filter((c): c is CiRecord => c !== undefined),
        slaTarget: window?.view.targetPercent ?? 0,
        errorBudgetRemainingMinutes: window?.budget?.remainingMinutes ?? 0,
        sla,
        currentWindow: window?.view ?? this.availability.emptyWindow(service.id),
      };
    });
  }

  async availabilityOf(
    tenantId: string,
    service: CiRecord,
    granularity: AvailabilityGranularity,
    periods: number | null,
  ): Promise<AvailabilityPeriodView[]> {
    const health = await this.facts.healthMap(tenantId, [service.id]);
    const [row] = await this.availability.periods(tenantId, [service], health, granularity, periods);
    return row?.periods ?? [];
  }

  async report(
    tenantId: string,
    granularity: AvailabilityGranularity,
    periods: number | null,
  ): Promise<ServiceAvailabilityView[]> {
    const services = await this.cis.byType(tenantId, SERVICE_TYPE);
    const health = await this.facts.healthMap(
      tenantId,
      services.map((s) => s.id),
    );
    return this.availability.periods(tenantId, services, health, granularity, periods);
  }

  async reportCsv(
    tenantId: string,
    granularity: AvailabilityGranularity,
    periods: number | null,
  ): Promise<string> {
    return AvailabilityService.toCsv(await this.report(tenantId, granularity, periods));
  }

  /** Incidents of the period's service open at some point inside it. */
  incidentsIn(tenantId: string, period: AvailabilityPeriodView): Promise<IncidentRecord[]> {
    return this.bsm.incidentsBetween(tenantId, [period.serviceCiId], period.periodStart, period.periodEnd);
  }

  /**
   * Incidents whose business service still exists. An incident that names a CI the estate no longer has (a replay
   * reset recreates CIs under new ids) would break the whole list through the non-null `Incident.service`, so it is
   * left out and counted in the log instead.
   */
  async incidents(tenantId: string, open: boolean, serviceId: string | null): Promise<IncidentRecord[]> {
    const all = await this.bsm.incidents(tenantId, { open, serviceCiId: serviceId });
    const serviceIds = [...new Set(all.map((i) => i.serviceCiId).filter((id): id is string => id !== null))];
    const present = new Set((await this.cis.findByIds(tenantId, serviceIds)).map((c) => c.id));
    const kept = all.filter((i) => i.serviceCiId !== null && present.has(i.serviceCiId));
    if (kept.length !== all.length)
      this.logger.warn(
        { tenantId, orphaned: all.length - kept.length },
        'incidents name business services the estate no longer has',
      );
    return kept;
  }

  incident(tenantId: string, id: string): Promise<IncidentRecord | null> {
    return this.bsm.incident(tenantId, id);
  }

  links(tenantId: string, incidentId: string): Promise<IncidentLinkRecord[]> {
    return this.bsm.links(tenantId, [incidentId]);
  }

  timeline(tenantId: string, incidentId: string): Promise<IncidentEventView[]> {
    return this.bsm.timeline(tenantId, incidentId);
  }

  acknowledge(tenantId: string, actor: string, incidentId: string): Promise<IncidentRecord> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const incident = await this.bsm.acknowledge(tx, tenantId, incidentId, nowIso());
      await emit({
        type: INCIDENT_UPDATED,
        subject: incident.id,
        data: { incidentId: incident.id, state: incident.state, action: 'acknowledged', by: actor },
      });
      return incident;
    });
  }

  assign(tenantId: string, actor: string, incidentId: string, assignee: string): Promise<IncidentRecord> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const incident = await this.bsm.assign(tx, tenantId, incidentId, assignee);
      await emit({
        type: INCIDENT_UPDATED,
        subject: incident.id,
        data: { incidentId: incident.id, state: incident.state, action: 'assigned', assignee, by: actor },
      });
      return incident;
    });
  }

  resolve(tenantId: string, actor: string, incidentId: string, note: string): Promise<IncidentRecord> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const incident = await this.bsm.resolve(tx, tenantId, incidentId, note, nowIso());
      await emit({
        type: INCIDENT_RESOLVED,
        subject: incident.id,
        data: {
          incidentId: incident.id,
          serviceId: incident.serviceCiId,
          action: 'resolved',
          note,
          by: actor,
        },
      });
      return incident;
    });
  }

  close(tenantId: string, actor: string, incidentId: string): Promise<IncidentRecord> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const incident = await this.bsm.close(tx, tenantId, incidentId, nowIso());
      await emit({
        type: INCIDENT_UPDATED,
        subject: incident.id,
        data: { incidentId: incident.id, state: incident.state, action: 'closed', by: actor },
      });
      return incident;
    });
  }

  updateRca(tenantId: string, actor: string, incidentId: string, input: RcaInput): Promise<IncidentRecord> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const incident = await this.bsm.updateRca(tx, tenantId, incidentId, input, actor, nowIso());
      await emit({
        type: INCIDENT_UPDATED,
        subject: incident.id,
        data: {
          incidentId: incident.id,
          action: 'rca_updated',
          rootCauseCiId: incident.rca?.rootCauseCiId ?? null,
          correctiveActions: incident.rca?.correctiveActions.length ?? 0,
          by: actor,
        },
      });
      return incident;
    });
  }

  slas(tenantId: string): Promise<SlaRecord[]> {
    return this.slaRepo.list(tenantId);
  }

  sla(tenantId: string, id: string): Promise<SlaRecord | null> {
    return this.slaRepo.byId(tenantId, id);
  }

  upsertSla(tenantId: string, actor: string, id: string | null, input: SlaInput): Promise<SlaRecord> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const sla = await this.slaRepo.upsert(tx, tenantId, id, input, actor);
      await emit({
        type: SLA_CHANGED,
        subject: sla.id,
        data: {
          action: id === null ? 'sla.created' : 'sla.updated',
          slaId: sla.id,
          name: sla.name,
          availabilityTargetPercent: sla.availabilityTargetPercent,
          window: sla.window,
          by: actor,
        },
      });
      return sla;
    });
  }

  deleteSla(tenantId: string, actor: string, id: string): Promise<boolean> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      await this.slaRepo.remove(tx, tenantId, id);
      await emit({ type: SLA_CHANGED, subject: id, data: { action: 'sla.deleted', slaId: id, by: actor } });
      return true;
    });
  }

  async assignSla(
    tenantId: string,
    actor: string,
    serviceId: string,
    slaId: string | null,
  ): Promise<ServiceHealthView> {
    const service = await this.cis.findById(tenantId, serviceId, null);
    if (!service || service.type !== SERVICE_TYPE)
      throw new NotFoundException('business service ' + serviceId + ' not found');
    await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      await this.slaRepo.assign(tx, tenantId, serviceId, slaId, actor);
      await emit({
        type: SLA_CHANGED,
        subject: serviceId,
        data: { action: slaId === null ? 'sla.unassigned' : 'sla.assigned', serviceId, slaId, by: actor },
      });
    });
    const [view] = await this.healthViews(tenantId, [service]);
    if (view === undefined) throw new NotFoundException('business service ' + serviceId + ' not found');
    return view;
  }

  async reportIncident(
    tenantId: string,
    actor: string,
    incidentId: string,
    integrationId: string,
  ): Promise<IncidentLinkRecord> {
    await this.integrations.assertOutboundAllowed(tenantId);
    const incident = await this.bsm.incident(tenantId, incidentId);
    if (!incident) throw new NotFoundException('incident ' + incidentId + ' not found');
    const config = await this.integrationsRepo.config(tenantId, integrationId);
    if (!config.enabled) throw new ServiceUnavailableException('integration ' + config.name + ' is disabled');
    const view = await this.incidentView(tenantId, incident);
    const request = incidentRequest(view, config);
    const headers = SecretsService.authHeaders(await this.secrets.read(config.credentialRef));
    const outcome = await deliver(
      { config, path: request.path, method: request.method, headers, body: request.body, eventId: null },
      {
        fetchImpl: fetch,
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, IN_REQUEST_BACKOFF_CAP_MS))),
        now: nowIso,
      },
    );
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      await this.integrationsRepo.recordDelivery(tx, outcome.delivery);
      const delivered = outcome.delivery.state === 'delivered';
      await this.integrationsRepo.recordStatus(
        tx,
        config.id,
        delivered
          ? { health: 'healthy', lastSuccessAt: nowIso(), lastError: null, delivered: 1 }
          : { health: 'failing', lastError: outcome.delivery.error, failed: 1 },
      );
      await emit({
        type: delivered ? 'openmap.integration.delivery.succeeded' : 'openmap.integration.delivery.failed',
        subject: incident.id,
        data: {
          incidentId: incident.id,
          integrationId: config.id,
          deliveryId: outcome.delivery.id,
          attempts: outcome.delivery.attempts,
          remoteId: outcome.remoteId,
          error: outcome.delivery.error,
          by: actor,
        },
      });
      if (!delivered)
        throw new ServiceUnavailableException(
          'delivery to ' + config.name + ' failed: ' + (outcome.delivery.error ?? 'unknown error'),
        );
      const remoteId = outcome.remoteId ?? outcome.delivery.id;
      return this.bsm.upsertLink(tx, tenantId, {
        incidentId: incident.id,
        integrationId: config.id,
        remoteId,
        remoteUrl: remoteUrlFor(config, remoteId),
        remoteState: 'open',
        syncedAt: nowIso(),
      });
    });
  }

  private async incidentView(tenantId: string, incident: IncidentRecord): Promise<IncidentView> {
    if (incident.serviceCiId === null)
      throw new NotFoundException('incident ' + incident.id + ' names no business service');
    const service = await this.cis.findById(tenantId, incident.serviceCiId, null);
    if (!service) throw new NotFoundException('service ' + incident.serviceCiId + ' not found');
    const rootCause =
      incident.rootCauseCiId === null
        ? null
        : await this.cis.findById(tenantId, incident.rootCauseCiId, null);
    const health = await this.facts.healthMap(tenantId, [service.id]);
    const facts = (await this.facts.factsFor(tenantId, [service], health)).get(service.id);
    return {
      id: incident.id,
      tenantId,
      serviceName: service.displayName,
      serviceTier: facts?.tier ?? 0,
      state: health.get(service.id) === 'down' ? 'down' : 'degraded',
      openedAt: incident.openedAt,
      rootCauseName: rootCause?.displayName ?? null,
      rootCauseCiId: rootCause?.id ?? null,
      affectedCiIds: incident.affectedServiceCiIds,
      alertCount: incident.alerts,
      usersAffected: facts?.usersAffected ?? null,
      ownerTeams: stringArrayAttribute(service.attributes, SERVICE_ATTRIBUTES.ownerTeams),
      summary: incident.description.length > 0 ? incident.description : incident.title,
    };
  }
}

export { HEALTH_CHANGED };
