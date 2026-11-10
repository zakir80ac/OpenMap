// REQ-INT-012 (ADR-073) — monitoring event ingest and the alert list. One request from Alertmanager, Zabbix, Nagios,
// Datadog, SolarWinds or Splunk is authenticated against its integration's OpenBao credential, parsed into monitoring
// events, resolved to CIs, and written in one transaction: the alerts (one row per source fingerprint), the inbound
// delivery and the integration's status, and an `openmap.integration.delivery.succeeded` outbox event that wakes the
// BSM engine, which overlays firing alerts on CI health (ADR-073). Operators map an unresolved source to a CI and
// clear an alert that will never be resolved by its sender.
import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MONITORING, TIME } from '@openmap/constants';
import {
  MonitoringPayloadError,
  POINT_IN_TIME_VENDORS,
  isMonitoringVendor,
  monitoringEffect,
  monitoringSettingsOf,
  monitoringSourceKeys,
  normalizeSourceKey,
  parseMonitoringPayload,
  type MonitoringEvent,
  type MonitoringSeverity,
  type MonitoringTarget,
  type ParsedMonitoringPayload,
} from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { isoOf, toIso } from '../common/time.js';
import { PrismaService } from '../db/prisma.service.js';
import { INTEGRATIONS_REPOSITORY, type IntegrationsRepository } from '../integrations/integrations.repository.js';
import { SecretsService, type Secret } from '../integrations/secrets.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { verifyIngestAuth, type PresentedAuth } from './monitoring-auth.js';
import { buildLookupIndex, chooseCi, type ResolvedCi } from './ci-lookup.js';

export interface IngestRequest extends PresentedAuth {
  body: unknown;
}

export interface IngestReport {
  accepted: number;
  resolved: number;
  unresolved: number;
  ignored: number;
}

export interface MonitoringAlertView {
  id: string;
  integrationId: string;
  integrationName: string;
  vendor: string;
  fingerprint: string;
  status: 'firing' | 'resolved';
  severity: MonitoringSeverity;
  effect: string | null;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  targets: MonitoringTarget[];
  ciId: string | null;
  resolution: string | null;
  startsAt: string;
  endsAt: string | null;
  expiresAt: string | null;
  firstReceivedAt: string;
  lastReceivedAt: string;
  receivedCount: number;
}

export interface MonitoringMappingView {
  id: string;
  sourceKey: string;
  ciId: string;
  createdBy: string;
  createdAt: string;
}

export interface MonitoringAlertsView {
  alerts: MonitoringAlertView[];
  firing: number;
  unresolved: number;
  mappings: MonitoringMappingView[];
}

export interface MonitoringFilter {
  status: 'firing' | 'resolved' | null;
  unresolvedOnly: boolean;
  first: number;
}

const DELIVERY_EVENT = 'openmap.integration.delivery.succeeded' as const;
const AUDIT_EVENT = 'openmap.audit.action' as const;
const FIRING = 'firing';
const RESOLVED = 'resolved';

type AlertRow = Prisma.MonitoringAlertGetPayload<{ include: { integration: { select: { name: true } } } }>;

function targetsOf(value: unknown): MonitoringTarget[] {
  return Array.isArray(value) ? (value as MonitoringTarget[]) : [];
}

export function toAlertView(row: AlertRow): MonitoringAlertView {
  return {
    id: row.id,
    integrationId: row.integrationId,
    integrationName: row.integration.name,
    vendor: row.vendor,
    fingerprint: row.fingerprint,
    status: row.status === FIRING ? FIRING : RESOLVED,
    severity: row.severity,
    effect: row.effect,
    title: row.title,
    description: row.description,
    sourceUrl: row.sourceUrl,
    targets: targetsOf(row.targets),
    ciId: row.ciId,
    resolution: row.resolution,
    startsAt: isoOf(row.startsAt),
    endsAt: toIso(row.endsAt),
    expiresAt: toIso(row.expiresAt),
    firstReceivedAt: isoOf(row.firstReceivedAt),
    lastReceivedAt: isoOf(row.lastReceivedAt),
    receivedCount: row.receivedCount,
  };
}

@Injectable()
export class MonitoringService {
  /** Credentials by OpenBao reference, kept briefly so a burst of alerts reads the vault once. */
  private readonly secretCache = new Map<string, { readAt: number; secret: Secret }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
    @Inject(INTEGRATIONS_REPOSITORY) private readonly integrations: IntegrationsRepository,
  ) {}

  private async credential(ref: string): Promise<Secret> {
    const cached = this.secretCache.get(ref);
    if (cached !== undefined && Date.now() - cached.readAt < MONITORING.secretCacheMs) return cached.secret;
    const secret = await this.secrets.read(ref);
    this.secretCache.set(ref, { readAt: Date.now(), secret });
    return secret;
  }

  /** One inbound request of a monitoring integration, end to end. */
  async ingest(integrationId: string, request: IngestRequest): Promise<IngestReport> {
    const row = await this.prisma.client.integrationConfig.findUnique({ where: { id: integrationId } });
    // Unknown, disabled, outbound-only and non-monitoring integrations look the same from outside.
    if (row === null || !row.enabled || row.category !== 'monitoring' || row.direction === 'outbound' || !isMonitoringVendor(row.vendor))
      throw new NotFoundException('no monitoring integration accepts events at this address');
    const vendor = row.vendor;
    return withSpan(TRACER_NAME, 'monitoring.ingest', { 'openmap.tenant': row.tenantId, 'openmap.vendor': vendor }, async (span) => {
      const settings = monitoringSettingsOf((row.settings ?? {}) as Record<string, unknown>);
      const verdict = verifyIngestAuth(await this.credential(row.credentialRef), request, { urlTokenAllowed: settings.urlToken, nowMs: Date.now() });
      if (!verdict.ok) {
        this.metrics.monitoringEvents.inc({ vendor, outcome: 'refused' });
        throw new UnauthorizedException(verdict.reason);
      }
      span.setAttribute('openmap.auth_method', verdict.method);
      const receivedAt = new Date();
      let parsed: ParsedMonitoringPayload;
      try {
        parsed = parseMonitoringPayload(vendor, request.body, { receivedAt: receivedAt.toISOString(), defaultSeverity: settings.defaultSeverity ?? MONITORING.defaultSeverity });
      } catch (err) {
        if (err instanceof MonitoringPayloadError) {
          this.metrics.monitoringEvents.inc({ vendor, outcome: 'invalid' });
          throw new BadRequestException(err.message);
        }
        throw err;
      }
      const index = await buildLookupIndex(this.prisma.client, row.tenantId, parsed.events.flatMap((e) => e.targets));
      const ttlMinutes = settings.resolveAfterMinutes ?? (POINT_IN_TIME_VENDORS.has(vendor) ? MONITORING.pointInTimeTtlMinutes : null);
      const report = await this.outbox.transaction(row.tenantId, async ({ tx, emit }) => {
        const resolutions = parsed.events.map((e) => chooseCi(e.targets, index));
        const resolvedCount = resolutions.filter((r) => r !== null).length;
        const envelope = await emit({
          type: DELIVERY_EVENT,
          subject: integrationId,
          data: {
            integrationId,
            direction: 'in',
            kind: MONITORING.deliveryKind,
            vendor,
            alerts: parsed.events.length,
            firing: parsed.events.filter((e) => e.status === FIRING).length,
            resolved: resolvedCount,
            unresolved: parsed.events.length - resolvedCount,
            ignored: parsed.ignored,
          },
        });
        const existing = new Map(
          (
            await tx.monitoringAlert.findMany({
              where: { integrationId, fingerprint: { in: parsed.events.map((e) => e.fingerprint) } },
            })
          ).map((a) => [a.fingerprint, a] as const),
        );
        for (const [i, event] of parsed.events.entries()) {
          const prior = existing.get(event.fingerprint);
          const found = resolutions[i] ?? null;
          await this.upsertAlert(tx, { tenantId: row.tenantId, integrationId, event, prior, found, maxEffect: settings.maxEffect, ttlMinutes, receivedAt, eventId: envelope.id });
        }
        await this.integrations.recordDelivery(tx, {
          id: randomUUID(),
          integrationId,
          tenantId: row.tenantId,
          direction: 'in',
          eventId: envelope.id,
          remoteId: parsed.events[0]?.fingerprint ?? null,
          state: 'delivered',
          attempts: 1,
          requestDigest: createHash('sha256').update(request.rawBody, 'utf8').digest('hex'),
          responseCode: null,
          error: null,
          createdAt: receivedAt.toISOString(),
          completedAt: new Date().toISOString(),
        });
        await this.integrations.recordStatus(tx, integrationId, { health: 'healthy', lastSuccessAt: receivedAt.toISOString(), lastError: null, delivered: 1 });
        return { accepted: parsed.events.length, resolved: resolvedCount, unresolved: parsed.events.length - resolvedCount, ignored: parsed.ignored };
      });
      this.metrics.monitoringEvents.inc({ vendor, outcome: 'resolved' }, report.resolved);
      this.metrics.monitoringEvents.inc({ vendor, outcome: 'unresolved' }, report.unresolved);
      this.metrics.monitoringEvents.inc({ vendor, outcome: 'ignored' }, report.ignored);
      span.setAttribute('openmap.alerts', report.accepted);
      return report;
    });
  }

  private async upsertAlert(
    tx: Prisma.TransactionClient,
    a: {
      tenantId: string;
      integrationId: string;
      event: MonitoringEvent;
      prior: Prisma.MonitoringAlertGetPayload<Record<string, never>> | undefined;
      found: ResolvedCi | null;
      maxEffect: ReturnType<typeof monitoringSettingsOf>['maxEffect'];
      ttlMinutes: number | null;
      receivedAt: Date;
      eventId: string;
    },
  ): Promise<void> {
    const { event, prior } = a;
    const firing = event.status === FIRING;
    // A resolve message says nothing new about severity or what the alert was; it keeps what the firing one said.
    const severity: MonitoringSeverity = !firing && prior !== undefined ? prior.severity : event.severity;
    const reopened = prior === undefined || prior.status !== FIRING;
    const kept: { ciId: string; resolution: string } | null =
      prior !== undefined && prior.ciId !== null ? { ciId: prior.ciId, resolution: prior.resolution ?? 'identity' } : null;
    const ci = a.found ?? kept;
    const data = {
      status: event.status,
      severity,
      effect: monitoringEffect(severity, a.maxEffect),
      title: !firing && prior !== undefined ? prior.title : event.title,
      description: event.description ?? prior?.description ?? null,
      sourceUrl: event.sourceUrl ?? prior?.sourceUrl ?? null,
      targets: (event.targets.length > 0 || prior === undefined ? event.targets : prior.targets) as unknown as Prisma.InputJsonArray,
      sourceKeys: event.targets.length > 0 || prior === undefined ? monitoringSourceKeys(event.targets) : prior.sourceKeys,
      labels: event.labels as Prisma.InputJsonObject,
      ciId: ci?.ciId ?? null,
      resolution: ci?.resolution ?? null,
      startsAt: firing && reopened ? new Date(event.startsAt) : (prior?.startsAt ?? new Date(event.startsAt)),
      endsAt: firing ? null : new Date(event.endsAt ?? a.receivedAt.toISOString()),
      expiresAt: firing && a.ttlMinutes !== null ? new Date(a.receivedAt.getTime() + a.ttlMinutes * TIME.secondsPerMinute * TIME.msPerSecond) : null,
      lastReceivedAt: a.receivedAt,
      lastEventId: a.eventId,
    };
    if (prior === undefined) {
      await tx.monitoringAlert.create({
        data: { ...data, tenantId: a.tenantId, integrationId: a.integrationId, vendor: event.vendor, fingerprint: event.fingerprint, firstReceivedAt: a.receivedAt },
      });
      return;
    }
    await tx.monitoringAlert.update({ where: { id: prior.id }, data: { ...data, receivedCount: { increment: 1 } } });
  }

  async list(tenantId: string, filter: MonitoringFilter): Promise<MonitoringAlertsView> {
    const where: Prisma.MonitoringAlertWhereInput = { tenantId };
    if (filter.status !== null) where.status = filter.status;
    if (filter.unresolvedOnly) where.ciId = null;
    const [rows, firing, unresolved, mappings] = await Promise.all([
      this.prisma.client.monitoringAlert.findMany({
        where,
        include: { integration: { select: { name: true } } },
        orderBy: [{ status: 'asc' }, { lastReceivedAt: 'desc' }],
        take: Math.min(Math.max(filter.first, 1), MONITORING.maxPageSize),
      }),
      this.prisma.client.monitoringAlert.count({ where: { tenantId, status: FIRING } }),
      this.prisma.client.monitoringAlert.count({ where: { tenantId, status: FIRING, ciId: null } }),
      this.prisma.client.monitoringSourceMapping.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: MONITORING.maxPageSize }),
    ]);
    return {
      alerts: rows.map(toAlertView),
      firing,
      unresolved,
      mappings: mappings.map((m) => ({ id: m.id, sourceKey: m.sourceKey, ciId: m.ciId, createdBy: m.createdBy, createdAt: isoOf(m.createdAt) })),
    };
  }

  /** Maps an alert source to a CI: the tenant's unresolved alerts naming it resolve now, later ones on arrival. */
  async map(tenantId: string, actor: string, rawKey: string, ciId: string): Promise<MonitoringMappingView> {
    const sourceKey = normalizeSourceKey(rawKey);
    if (sourceKey === '') throw new BadRequestException('the source key is empty');
    const ci = await this.prisma.client.ci.findFirst({ where: { tenantId, id: ciId, validTo: null }, select: { id: true } });
    if (ci === null) throw new NotFoundException('CI ' + ciId + ' not found');
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const mapping = await tx.monitoringSourceMapping.upsert({
        where: { tenantId_sourceKey: { tenantId, sourceKey } },
        create: { tenantId, sourceKey, ciId, createdBy: actor },
        update: { ciId, createdBy: actor },
      });
      const alerts = await tx.$executeRaw(Prisma.sql`
        UPDATE monitoring_alerts SET "ciId" = ${ciId}::uuid, resolution = 'mapping', "updatedAt" = now()
        WHERE "tenantId" = ${tenantId}::uuid AND ("ciId" IS NULL OR resolution = 'mapping') AND "sourceKeys" @> ARRAY[${sourceKey}]::text[]`);
      await emit({ type: AUDIT_EVENT, subject: ciId, data: { action: MONITORING.auditActions.mapped, sourceKey, ciId, alerts, by: actor } });
      return { id: mapping.id, sourceKey, ciId, createdBy: actor, createdAt: isoOf(mapping.createdAt) };
    });
  }

  /** Resolves an alert by hand (its sender will never say so); the CI's health follows on the engine's next pass. */
  async clear(tenantId: string, actor: string, id: string): Promise<MonitoringAlertView> {
    const existing = await this.prisma.client.monitoringAlert.findFirst({ where: { tenantId, id } });
    if (existing === null) throw new NotFoundException('monitoring alert ' + id + ' not found');
    return this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      const row = await tx.monitoringAlert.update({
        where: { id },
        data: { status: RESOLVED, endsAt: existing.endsAt ?? new Date(), expiresAt: null },
        include: { integration: { select: { name: true } } },
      });
      await emit({ type: AUDIT_EVENT, subject: id, data: { action: MONITORING.auditActions.cleared, alertId: id, ciId: row.ciId, by: actor } });
      return toAlertView(row);
    });
  }
}
