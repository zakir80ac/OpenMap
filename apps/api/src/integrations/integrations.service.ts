// REQ-INT-005 — integration use cases: list, upsert and connectivity test. Outbound calls are gated
// by the deployment feature switch, the air-gap profile and the tenant setting.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PERF_BUDGETS } from '@openmap/constants';
import { NOTIFICATION_TEST_EVENT, isNotificationVendor } from '@openmap/contracts';
import { MetricsService } from '../metrics/metrics.service.js';
import { ENV, type Env } from '../config/env.module.js';
import { nowIso } from '../common/time.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { TenantSettingsService } from '../tenant/tenant-settings.service.js';
import { INTEGRATIONS_REPOSITORY, type IntegrationsRepository } from './integrations.repository.js';
import type { IntegrationInput } from './integrations.schemas.js';
import { SecretsService } from './secrets.service.js';
import type {
  IntegrationDeliveryView,
  IntegrationDetailView,
  IntegrationView,
} from './integrations.types.js';

/** Connectivity probes wait at most the impact-query budget; a slower remote is reported as failing. */
export const PROBE_TIMEOUT_MS = PERF_BUDGETS.impactQuery100kP95Ms;

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(INTEGRATIONS_REPOSITORY) private readonly repo: IntegrationsRepository,
    @Inject(ENV) private readonly env: Env,
    private readonly settings: TenantSettingsService,
    private readonly secrets: SecretsService,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
  ) {}

  list(tenantId: string, category: string | null): Promise<IntegrationView[]> {
    return this.repo.list(tenantId, category);
  }

  async detail(tenantId: string, id: string): Promise<IntegrationDetailView> {
    const view = await this.repo.detail(tenantId, id);
    if (!view) throw new NotFoundException('integration ' + id + ' not found');
    return view;
  }

  deliveries(tenantId: string, integrationId: string, first: number): Promise<IntegrationDeliveryView[]> {
    return this.repo.deliveries(tenantId, integrationId, first);
  }

  async require(tenantId: string, id: string): Promise<IntegrationView> {
    const view = await this.repo.view(tenantId, id);
    if (!view) throw new NotFoundException('integration ' + id + ' not found');
    return view;
  }

  byIds(tenantId: string, ids: readonly string[]): Promise<IntegrationView[]> {
    return this.repo.viewsByIds(tenantId, ids);
  }

  /** Throws unless this deployment and this tenant allow outbound integration traffic. */
  async assertOutboundAllowed(tenantId: string): Promise<void> {
    if (this.env.DEPLOY_PROFILE === 'airgap' || !this.env.FEATURE_OUTBOUND_INTEGRATIONS) {
      throw new ForbiddenException(
        'outbound integrations are disabled in this deployment (FEATURE_OUTBOUND_INTEGRATIONS / airgap profile)',
      );
    }
    const settings = await this.settings.get(tenantId);
    if (!settings.outboundIntegrationsEnabled)
      throw new ForbiddenException('outbound integrations are disabled for this tenant');
  }

  upsert(
    tenantId: string,
    actor: string,
    id: string | null,
    input: IntegrationInput,
  ): Promise<IntegrationView> {
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const view = await this.repo.upsert(tx, tenantId, id, input);
      await emit({
        type: 'openmap.audit.action',
        subject: view.id,
        data: {
          action: id === null ? 'integration.created' : 'integration.updated',
          integrationId: view.id,
          vendor: view.vendor,
          by: actor,
        },
      });
      return view;
    });
  }

  /**
   * REQ-INT-009 (ADR-065): asks the BSM engine, through the outbox, to send a test message on one notification
   * integration (webhook, Slack, Teams, email, PagerDuty). The engine records the attempt as a delivery.
   */
  async sendTestNotification(tenantId: string, actor: string, id: string): Promise<boolean> {
    await this.assertOutboundAllowed(tenantId);
    const view = await this.require(tenantId, id);
    if (!isNotificationVendor(view.vendor))
      throw new BadRequestException('integration ' + id + ' is not a notification integration');
    if (!view.enabled) throw new BadRequestException('integration ' + id + ' is disabled');
    await this.outbox.transaction(tenantId, async ({ emit }) => {
      await emit({
        type: NOTIFICATION_TEST_EVENT,
        subject: id,
        data: { integrationId: id, vendor: view.vendor, by: actor },
      });
      await emit({
        type: 'openmap.audit.action',
        subject: id,
        data: {
          action: 'integration.notification.tested',
          integrationId: id,
          vendor: view.vendor,
          by: actor,
        },
      });
    });
    this.metrics.notificationTests.inc({ vendor: view.vendor });
    return true;
  }

  /** Resolves the credential and probes the endpoint; the outcome is recorded as the integration's status. */
  async test(tenantId: string, id: string): Promise<IntegrationView> {
    await this.assertOutboundAllowed(tenantId);
    const config = await this.repo.config(tenantId, id);
    let error: string | null = null;
    try {
      const headers = SecretsService.authHeaders(await this.secrets.read(config.credentialRef));
      const res = await fetch(config.endpoint, {
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) error = 'HTTP ' + String(res.status);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      await this.repo.recordStatus(
        tx,
        id,
        error === null
          ? { health: 'healthy', lastSuccessAt: nowIso(), lastError: null }
          : { health: 'failing', lastError: error },
      );
      await emit({
        type:
          error === null ? 'openmap.integration.delivery.succeeded' : 'openmap.integration.delivery.failed',
        subject: id,
        data: { integrationId: id, probe: true, error },
      });
      return this.require(tenantId, id);
    });
  }
}
