// REQ-BSM-002 REQ-BSM-006 — BSM persistence: incidents (with response targets and RCA), incident links, and the two
// sources of an incident's timeline (audit entries and outbox events). Interface plus Prisma implementation (ADR-024).
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@openmap/db';
import { isoOf, toIso } from '../common/time.js';
import { asRecord } from '../common/validation.js';
import { PrismaService } from '../db/prisma.service.js';
import { rcaStoredSchema, type RcaInput } from './services.schemas.js';
import type { IncidentEventView, IncidentLinkRecord, IncidentRecord, RcaView } from './services.types.js';

export const BSM_REPOSITORY = Symbol('BSM_REPOSITORY');

/** Event type the BSM engine emits on every service state change. */
export const HEALTH_CHANGED = 'openmap.bsm.health.changed';

export interface IncidentsQuery {
  open: boolean;
  serviceCiId: string | null;
}

export interface BsmRepository {
  incidents(tenantId: string, query: IncidentsQuery): Promise<IncidentRecord[]>;
  incident(tenantId: string, id: string): Promise<IncidentRecord | null>;
  /** Incidents of the services that were open at some point inside [start, end). */
  incidentsBetween(
    tenantId: string,
    serviceCiIds: readonly string[],
    start: string,
    end: string,
  ): Promise<IncidentRecord[]>;
  acknowledge(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    at: string,
  ): Promise<IncidentRecord>;
  assign(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    assignee: string,
  ): Promise<IncidentRecord>;
  resolve(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    note: string,
    at: string,
  ): Promise<IncidentRecord>;
  close(tx: Prisma.TransactionClient, tenantId: string, id: string, at: string): Promise<IncidentRecord>;
  updateRca(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    input: RcaInput,
    actor: string,
    at: string,
  ): Promise<IncidentRecord>;
  links(tenantId: string, incidentIds: readonly string[]): Promise<IncidentLinkRecord[]>;
  upsertLink(
    tx: Prisma.TransactionClient,
    tenantId: string,
    link: IncidentLinkRecord,
  ): Promise<IncidentLinkRecord>;
  /** Audit entries and outbox events about the incident, oldest first. */
  timeline(tenantId: string, incidentId: string): Promise<IncidentEventView[]>;
}

type IncidentRow = Awaited<ReturnType<PrismaClient['incident']['findUniqueOrThrow']>>;
type LinkRow = Awaited<ReturnType<PrismaClient['incidentLink']['findUniqueOrThrow']>>;

const INCIDENT_SUBJECT_TYPE = 'Incident';
const ACTIVE_STATES = ['open', 'acknowledged', 'mitigated'] as const;

function toRca(value: Prisma.JsonValue | null): RcaView | null {
  if (value === null) return null;
  const parsed = rcaStoredSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toIncident(row: IncidentRow): IncidentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    description: row.description,
    severity: row.severity,
    state: row.state,
    source: row.source,
    serviceCiId: row.affectedServiceCiIds[0] ?? null,
    affectedServiceCiIds: row.affectedServiceCiIds,
    rootCauseCiId: row.rootCauseCiId,
    slaId: row.slaId,
    openedAt: isoOf(row.openedAt),
    acknowledgedAt: toIso(row.acknowledgedAt),
    resolvedAt: toIso(row.resolvedAt),
    closedAt: toIso(row.closedAt),
    assignee: row.assignee,
    respondBy: toIso(row.respondBy),
    resolveBy: toIso(row.resolveBy),
    responseBreachedAt: toIso(row.responseBreachedAt),
    resolutionBreachedAt: toIso(row.resolutionBreachedAt),
    resolutionNote: row.resolutionNote,
    rca: toRca(row.rca),
    alerts: row.correlatedEventIds.length,
  };
}

function toLink(row: LinkRow): IncidentLinkRecord {
  return {
    incidentId: row.incidentId,
    integrationId: row.integrationId,
    remoteId: row.remoteId,
    remoteUrl: row.remoteUrl,
    remoteState: row.remoteState,
    syncedAt: isoOf(row.syncedAt),
  };
}

@Injectable()
export class PrismaBsmRepository implements BsmRepository {
  constructor(private readonly prisma: PrismaService) {}

  async incidents(tenantId: string, query: IncidentsQuery): Promise<IncidentRecord[]> {
    const where: Prisma.IncidentWhereInput = { tenantId };
    if (query.open) where.state = { in: [...ACTIVE_STATES] };
    if (query.serviceCiId !== null) where.affectedServiceCiIds = { has: query.serviceCiId };
    const rows = await this.prisma.client.incident.findMany({ where, orderBy: { openedAt: 'desc' } });
    return rows.map(toIncident);
  }

  async incident(tenantId: string, id: string): Promise<IncidentRecord | null> {
    const row = await this.prisma.client.incident.findFirst({ where: { id, tenantId } });
    return row ? toIncident(row) : null;
  }

  async incidentsBetween(
    tenantId: string,
    serviceCiIds: readonly string[],
    start: string,
    end: string,
  ): Promise<IncidentRecord[]> {
    if (serviceCiIds.length === 0) return [];
    const rows = await this.prisma.client.incident.findMany({
      where: {
        tenantId,
        affectedServiceCiIds: { hasSome: [...serviceCiIds] },
        openedAt: { lt: new Date(end) },
        OR: [{ resolvedAt: null }, { resolvedAt: { gte: new Date(start) } }],
      },
      orderBy: { openedAt: 'desc' },
    });
    return rows.map(toIncident);
  }

  private async require(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<IncidentRow> {
    const existing = await tx.incident.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('incident ' + id + ' not found');
    return existing;
  }

  async acknowledge(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    at: string,
  ): Promise<IncidentRecord> {
    const existing = await this.require(tx, tenantId, id);
    if (existing.state !== 'open') return toIncident(existing);
    const row = await tx.incident.update({
      where: { id },
      data: { state: 'acknowledged', acknowledgedAt: new Date(at) },
    });
    return toIncident(row);
  }

  /** Assigning acknowledges an open incident too: someone has taken it. */
  async assign(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    assignee: string,
  ): Promise<IncidentRecord> {
    const existing = await this.require(tx, tenantId, id);
    const acknowledge =
      existing.state === 'open'
        ? { state: 'acknowledged' as const, acknowledgedAt: existing.acknowledgedAt ?? new Date() }
        : {};
    const row = await tx.incident.update({ where: { id }, data: { assignee, ...acknowledge } });
    return toIncident(row);
  }

  async resolve(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    note: string,
    at: string,
  ): Promise<IncidentRecord> {
    const existing = await this.require(tx, tenantId, id);
    if (existing.state === 'resolved' || existing.state === 'closed') return toIncident(existing);
    const row = await tx.incident.update({
      where: { id },
      data: {
        state: 'resolved',
        resolvedAt: new Date(at),
        resolutionNote: note,
        acknowledgedAt: existing.acknowledgedAt ?? new Date(at),
      },
    });
    await tx.incidentLink.updateMany({
      where: { incidentId: id },
      data: { remoteState: 'resolved', syncedAt: new Date(at) },
    });
    return toIncident(row);
  }

  async close(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    at: string,
  ): Promise<IncidentRecord> {
    const existing = await this.require(tx, tenantId, id);
    if (existing.state === 'closed') return toIncident(existing);
    const row = await tx.incident.update({
      where: { id },
      data: { state: 'closed', closedAt: new Date(at), resolvedAt: existing.resolvedAt ?? new Date(at) },
    });
    return toIncident(row);
  }

  async updateRca(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    input: RcaInput,
    actor: string,
    at: string,
  ): Promise<IncidentRecord> {
    await this.require(tx, tenantId, id);
    const rca: RcaView = {
      summary: input.summary,
      rootCauseCiId: input.rootCauseCiId ?? null,
      contributingFactors: input.contributingFactors ?? [],
      correctiveActions: (input.correctiveActions ?? []).map((a) => ({
        description: a.description,
        owner: a.owner ?? null,
        dueAt: a.dueAt ?? null,
        done: a.done ?? false,
      })),
      owner: input.owner ?? null,
      dueAt: input.dueAt ?? null,
      completedAt: input.completedAt ?? null,
      updatedBy: actor,
      updatedAt: at,
    };
    const row = await tx.incident.update({
      where: { id },
      data: { rca: rca as unknown as Prisma.InputJsonObject, rootCauseCiId: rca.rootCauseCiId },
    });
    return toIncident(row);
  }

  async links(tenantId: string, incidentIds: readonly string[]): Promise<IncidentLinkRecord[]> {
    if (incidentIds.length === 0) return [];
    const rows = await this.prisma.client.incidentLink.findMany({
      where: { tenantId, incidentId: { in: [...incidentIds] } },
    });
    return rows.map(toLink);
  }

  async upsertLink(
    tx: Prisma.TransactionClient,
    tenantId: string,
    link: IncidentLinkRecord,
  ): Promise<IncidentLinkRecord> {
    const data = {
      remoteId: link.remoteId,
      remoteUrl: link.remoteUrl,
      remoteState: link.remoteState,
      syncedAt: new Date(link.syncedAt),
    };
    const row = await tx.incidentLink.upsert({
      where: { incidentId_integrationId: { incidentId: link.incidentId, integrationId: link.integrationId } },
      create: { tenantId, incidentId: link.incidentId, integrationId: link.integrationId, ...data },
      update: data,
    });
    return toLink(row);
  }

  async timeline(tenantId: string, incidentId: string): Promise<IncidentEventView[]> {
    const [audits, events] = await Promise.all([
      this.prisma.client.auditLog.findMany({
        where: { tenantId, subjectType: INCIDENT_SUBJECT_TYPE, subjectId: incidentId },
        orderBy: { at: 'asc' },
      }),
      this.prisma.client.outboxEvent.findMany({
        where: { tenantId, subject: incidentId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const out: IncidentEventView[] = [];
    for (const a of audits)
      out.push({ at: isoOf(a.at), actor: a.actor, kind: a.action, details: asRecord(a.details) });
    for (const e of events) {
      const envelope = asRecord(e.envelope);
      const data = asRecord(envelope['data']);
      const by = data['by'];
      const action = data['action'];
      out.push({
        at: isoOf(e.createdAt),
        actor: typeof by === 'string' ? by : String(envelope['source'] ?? ''),
        kind: e.type + (typeof action === 'string' ? ':' + action : ''),
        details: data,
      });
    }
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
}
