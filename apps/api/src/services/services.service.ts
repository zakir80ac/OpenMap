// REQ-BSM-002 — business service management use cases: service health from stored states and SLA
// budgets, incidents, acknowledgement, and reporting an incident to an ITSM or SIEM integration.
import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { deliver, type IncidentView } from '@openmap/bsm-engine';
import { PERF_BUDGETS } from '@openmap/constants';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord, HealthState } from '../ci/ci.types.js';
import { nowIso } from '../common/time.js';
import { stringArrayAttribute } from '../common/validation.js';
import { INTEGRATIONS_REPOSITORY, type IntegrationsRepository } from '../integrations/integrations.repository.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { BsmFactsService, SERVICE_ATTRIBUTES } from './bsm-facts.service.js';
import { incidentRequest, remoteUrlFor } from './incident-delivery.js';
import { BSM_REPOSITORY, HEALTH_CHANGED, type BsmRepository } from './services.repository.js';
import type { IncidentLinkRecord, IncidentRecord, ServiceHealthView } from './services.types.js';

/** Retry back-off inside a request is capped at the impact-query budget; dead letters are redelivered by the reconciler. */
export const IN_REQUEST_BACKOFF_CAP_MS = PERF_BUDGETS.impactQuery100kP95Ms;

@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);

  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    @Inject(BSM_REPOSITORY) private readonly bsm: BsmRepository,
    @Inject(INTEGRATIONS_REPOSITORY) private readonly integrationsRepo: IntegrationsRepository,
    private readonly integrations: IntegrationsService,
    private readonly secrets: SecretsService,
    private readonly facts: BsmFactsService,
    private readonly outbox: OutboxService,
  ) {}

  async services(tenantId: string, states: readonly HealthState[] | null): Promise<ServiceHealthView[]> {
    const services = await this.cis.byType(tenantId, 'business_service');
    const views = await Promise.all(services.map((s) => this.healthView(tenantId, s)));
    return states === null || states.length === 0 ? views : views.filter((v) => states.includes(v.state));
  }

  async healthViewById(tenantId: string, serviceId: string): Promise<ServiceHealthView | null> {
    const service = await this.cis.findById(tenantId, serviceId, null);
    return service ? this.healthView(tenantId, service) : null;
  }

  async healthView(tenantId: string, service: CiRecord): Promise<ServiceHealthView> {
    const h = await this.facts.healthOf(tenantId, service);
    const [lastChange] = await this.bsm.healthBefore(tenantId, [service.id], nowIso());
    const rootCauses = await this.cis.findByIds(tenantId, h.rootCauseIds);
    return {
      service,
      state: h.state,
      since: lastChange ? lastChange.at : service.validFrom,
      rootCauses,
      slaTarget: h.slaTarget,
      errorBudgetRemainingMinutes: h.sla ? h.sla.remainingMinutes : 0,
    };
  }

  /**
   * Incidents whose business service still exists. An incident that names a CI the estate no longer has (a replay
   * reset recreates CIs under new ids) would break the whole list through the non-null `Incident.service`, so it is
   * left out and counted in the log instead.
   */
  async incidents(tenantId: string, open: boolean): Promise<IncidentRecord[]> {
    const all = await this.bsm.incidents(tenantId, open);
    const serviceIds = [...new Set(all.map((i) => i.serviceCiId).filter((id): id is string => id !== null))];
    const present = new Set((await this.cis.findByIds(tenantId, serviceIds)).map((c) => c.id));
    const kept = all.filter((i) => i.serviceCiId !== null && present.has(i.serviceCiId));
    if (kept.length !== all.length) this.logger.warn({ tenantId, orphaned: all.length - kept.length }, 'incidents name business services the estate no longer has');
    return kept;
  }

  links(tenantId: string, incidentId: string): Promise<IncidentLinkRecord[]> {
    return this.bsm.links(tenantId, [incidentId]);
  }

  acknowledge(tenantId: string, actor: string, incidentId: string): Promise<IncidentRecord> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const incident = await this.bsm.acknowledge(tx, tenantId, incidentId, nowIso());
      await emit({ type: 'openmap.incident.updated', subject: incident.id, data: { incidentId: incident.id, state: incident.state, by: actor } });
      return incident;
    });
  }

  async reportIncident(tenantId: string, actor: string, incidentId: string, integrationId: string): Promise<IncidentLinkRecord> {
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
      { fetchImpl: fetch, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, IN_REQUEST_BACKOFF_CAP_MS))), now: nowIso },
    );
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      await this.integrationsRepo.recordDelivery(tx, outcome.delivery);
      const delivered = outcome.delivery.state === 'delivered';
      await this.integrationsRepo.recordStatus(tx, config.id, delivered ? { health: 'healthy', lastSuccessAt: nowIso(), lastError: null, delivered: 1 } : { health: 'failing', lastError: outcome.delivery.error, failed: 1 });
      await emit({
        type: delivered ? 'openmap.integration.delivery.succeeded' : 'openmap.integration.delivery.failed',
        subject: incident.id,
        data: { incidentId: incident.id, integrationId: config.id, deliveryId: outcome.delivery.id, attempts: outcome.delivery.attempts, remoteId: outcome.remoteId, error: outcome.delivery.error, by: actor },
      });
      if (!delivered) throw new ServiceUnavailableException('delivery to ' + config.name + ' failed: ' + (outcome.delivery.error ?? 'unknown error'));
      const remoteId = outcome.remoteId ?? outcome.delivery.id;
      return this.bsm.upsertLink(tx, tenantId, { incidentId: incident.id, integrationId: config.id, remoteId, remoteUrl: remoteUrlFor(config, remoteId), remoteState: 'open', syncedAt: nowIso() });
    });
  }

  private async incidentView(tenantId: string, incident: IncidentRecord): Promise<IncidentView> {
    if (incident.serviceCiId === null) throw new NotFoundException('incident ' + incident.id + ' names no business service');
    const service = await this.cis.findById(tenantId, incident.serviceCiId, null);
    if (!service) throw new NotFoundException('service ' + incident.serviceCiId + ' not found');
    const rootCause = incident.rootCauseCiId === null ? null : await this.cis.findById(tenantId, incident.rootCauseCiId, null);
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
