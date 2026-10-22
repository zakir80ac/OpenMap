// REQ-BSM-002 — BSM persistence: incidents, incident links and the health-change event history that
// the SLA arithmetic reads. Interface plus Prisma implementation.
import { Injectable, NotFoundException } from '@nestjs/common';
import { BSM } from '@openmap/constants';
import type { Prisma, PrismaClient } from '@openmap/db';
import { isoOf, toIso } from '../common/time.js';
import { asRecord } from '../common/validation.js';
import { PrismaService } from '../db/prisma.service.js';
import type { HealthEvent, IncidentLinkRecord, IncidentRecord } from './services.types.js';

export const BSM_REPOSITORY = Symbol('BSM_REPOSITORY');

/** Event type the BSM engine emits on every service state change. */
export const HEALTH_CHANGED = 'openmap.bsm.health.changed';

export interface BsmRepository {
  incidents(tenantId: string, open: boolean): Promise<IncidentRecord[]>;
  incident(tenantId: string, id: string): Promise<IncidentRecord | null>;
  acknowledge(tx: Prisma.TransactionClient, tenantId: string, id: string, at: string): Promise<IncidentRecord>;
  links(tenantId: string, incidentIds: readonly string[]): Promise<IncidentLinkRecord[]>;
  upsertLink(tx: Prisma.TransactionClient, tenantId: string, link: IncidentLinkRecord): Promise<IncidentLinkRecord>;
  /** Health changes for the subjects since `since`, oldest first. */
  healthEvents(tenantId: string, subjects: readonly string[], since: string): Promise<HealthEvent[]>;
  /** Latest health change per subject strictly before `before`. */
  healthBefore(tenantId: string, subjects: readonly string[], before: string): Promise<HealthEvent[]>;
}

type IncidentRow = Awaited<ReturnType<PrismaClient['incident']['findUniqueOrThrow']>>;
type LinkRow = Awaited<ReturnType<PrismaClient['incidentLink']['findUniqueOrThrow']>>;
type OutboxRow = Awaited<ReturnType<PrismaClient['outboxEvent']['findUniqueOrThrow']>>;

function toIncident(row: IncidentRow): IncidentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    description: row.description,
    state: row.state,
    serviceCiId: row.affectedServiceCiIds[0] ?? null,
    affectedServiceCiIds: row.affectedServiceCiIds,
    rootCauseCiId: row.rootCauseCiId,
    openedAt: isoOf(row.openedAt),
    acknowledgedAt: toIso(row.acknowledgedAt),
    resolvedAt: toIso(row.resolvedAt),
    alerts: row.correlatedEventIds.length,
  };
}

function toLink(row: LinkRow): IncidentLinkRecord {
  return { incidentId: row.incidentId, integrationId: row.integrationId, remoteId: row.remoteId, remoteUrl: row.remoteUrl, remoteState: row.remoteState, syncedAt: isoOf(row.syncedAt) };
}

const HEALTH_STATES = new Set<string>(BSM.healthOrder);

function toHealthEvent(row: OutboxRow): HealthEvent | null {
  const data = asRecord(asRecord(row.envelope)['data']);
  const state = data['state'];
  if (typeof state !== 'string' || !HEALTH_STATES.has(state)) return null;
  return { subject: row.subject, state: state as HealthEvent['state'], at: isoOf(row.createdAt) };
}

@Injectable()
export class PrismaBsmRepository implements BsmRepository {
  constructor(private readonly prisma: PrismaService) {}

  async incidents(tenantId: string, open: boolean): Promise<IncidentRecord[]> {
    const where: Prisma.IncidentWhereInput = open ? { tenantId, resolvedAt: null } : { tenantId };
    const rows = await this.prisma.client.incident.findMany({ where, orderBy: { openedAt: 'desc' } });
    return rows.map(toIncident);
  }

  async incident(tenantId: string, id: string): Promise<IncidentRecord | null> {
    const row = await this.prisma.client.incident.findFirst({ where: { id, tenantId } });
    return row ? toIncident(row) : null;
  }

  async acknowledge(tx: Prisma.TransactionClient, tenantId: string, id: string, at: string): Promise<IncidentRecord> {
    const existing = await tx.incident.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('incident ' + id + ' not found');
    if (existing.state !== 'open') return toIncident(existing);
    const row = await tx.incident.update({ where: { id }, data: { state: 'acknowledged', acknowledgedAt: new Date(at) } });
    return toIncident(row);
  }

  async links(tenantId: string, incidentIds: readonly string[]): Promise<IncidentLinkRecord[]> {
    if (incidentIds.length === 0) return [];
    const rows = await this.prisma.client.incidentLink.findMany({ where: { tenantId, incidentId: { in: [...incidentIds] } } });
    return rows.map(toLink);
  }

  async upsertLink(tx: Prisma.TransactionClient, tenantId: string, link: IncidentLinkRecord): Promise<IncidentLinkRecord> {
    const data = { remoteId: link.remoteId, remoteUrl: link.remoteUrl, remoteState: link.remoteState, syncedAt: new Date(link.syncedAt) };
    const row = await tx.incidentLink.upsert({
      where: { incidentId_integrationId: { incidentId: link.incidentId, integrationId: link.integrationId } },
      create: { tenantId, incidentId: link.incidentId, integrationId: link.integrationId, ...data },
      update: data,
    });
    return toLink(row);
  }

  async healthEvents(tenantId: string, subjects: readonly string[], since: string): Promise<HealthEvent[]> {
    if (subjects.length === 0) return [];
    const rows = await this.prisma.client.outboxEvent.findMany({
      where: { tenantId, type: HEALTH_CHANGED, subject: { in: [...subjects] }, createdAt: { gte: new Date(since) } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toHealthEvent).filter((e): e is HealthEvent => e !== null);
  }

  async healthBefore(tenantId: string, subjects: readonly string[], before: string): Promise<HealthEvent[]> {
    const out: HealthEvent[] = [];
    for (const subject of subjects) {
      const row = await this.prisma.client.outboxEvent.findFirst({
        where: { tenantId, type: HEALTH_CHANGED, subject, createdAt: { lt: new Date(before) } },
        orderBy: { createdAt: 'desc' },
      });
      const event = row ? toHealthEvent(row) : null;
      if (event) out.push(event);
    }
    return out;
  }
}
