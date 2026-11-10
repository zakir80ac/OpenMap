// REQ-BSM-001 REQ-BSM-002 REQ-BSM-003 REQ-BSM-006 REQ-BSM-008 REQ-INT-005 REQ-INT-006 — the running BSM engine:
// turns CI change events into CI health on the graph, propagates health through redundancy groups to business
// services, records health changes and SLA facts through the outbox, opens, updates and resolves incidents with
// response and resolution deadlines, evaluates every assigned SLA over its window (breach incidents, at-risk alerts),
// stamps missed targets, and delivers incidents to the ITSM, SIEM and on-call integrations that subscribed (ADR-024).
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS, ITSM, type SlaWindow } from '@openmap/constants';
import { TENANT_SETTINGS_DEFAULTS } from '@openmap/config';
import {
  eventEnvelopeSchema,
  integrationConfigSchema,
  NOTIFICATION_VENDORS,
  type Ci,
  type EventEnvelope,
  type EventType,
  type IntegrationConfig,
  CONNECTIVITY_ATTRIBUTES,
} from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import type { GraphRepository } from '@openmap/graph';
import { z } from 'zod';
import { availabilityIn, changesOf, slaWindowAt, windowBudget } from '../core/availability.js';
import type { HealthHistoryReader } from '../core/history.js';
import { propagateAll, type Health, type ServiceModel, type ServiceState } from '../core/propagate.js';
import { deliver, type DeliveryDeps } from '../integrations/delivery.js';
import { authHeaders, incidentRequest, remoteUrlFor } from '../integrations/routes.js';
import type { IncidentView } from '../integrations/payloads.js';
import { deriveHealth } from './health-rules.js';
import { incidentActions, type OpenIncident, type ServiceSummary } from './incidents.js';
import {
  slaActions,
  targetBreaches,
  targetsFor,
  type SeverityTargets,
  type SlaDefinition,
  type SlaServiceInput,
} from './sla.js';

export const ENGINE_SOURCE = '/openmap/bsm-engine';
export const HEALTH_CHANGED: EventType = 'openmap.bsm.health.changed';
export const INCIDENT_OPENED: EventType = 'openmap.incident.opened';
export const INCIDENT_UPDATED: EventType = 'openmap.incident.updated';
export const INCIDENT_RESOLVED: EventType = 'openmap.incident.resolved';
export const SLA_BREACHED: EventType = 'openmap.bsm.sla.breached';
export const SLA_AT_RISK: EventType = 'openmap.bsm.sla.at_risk';
const SLA_SOURCE = 'sla';
const WINDOW_ROLLED_NOTE = 'SLA window rolled over within budget';
const CI_EVENT_TYPES: ReadonlySet<string> = new Set([
  'openmap.ci.created',
  'openmap.ci.updated',
  'openmap.ci.labelled',
]);
const SERVICE_TYPE = 'business_service';
const PART_OF_SERVICE = 'part_of_service';
const ATTR = {
  tier: 'tier',
  usersAffected: 'usersAffected',
  ownerTeams: 'ownerTeams',
  redundancyGroup: 'redundancyGroup',
  minHealthy: 'minHealthy',
} as const;
// UNWIND + MATCH by id hits the unique id index once per id; a parameterised `WHERE c.id IN $ids` is evaluated per
// node over the tenant's CIs in Memgraph (1.0 s for 2,400 ids on a 28k-CI tenant against 80 ms, measured over Bolt).
const HEALTH_QUERY =
  'UNWIND $ids AS id MATCH (c:Ci {id: id, tenantId: $tenantId}) RETURN c.id AS id, c.health AS health';
const SOURCE_NAME = 'bsm';
const ACTIVE_INCIDENT_STATES = ['open', 'acknowledged', 'mitigated'] as const;

export interface SecretsReader {
  read(ref: string): Promise<{ type: string; fields: Record<string, string> }>;
}

export interface EngineDeps {
  prisma: PrismaClient;
  graph: GraphRepository;
  secrets: SecretsReader;
  delivery: DeliveryDeps;
  /** The service health history (ClickHouse); the availability source for SLA evaluation. */
  history: HealthHistoryReader;
  now: () => string;
  log: (line: Record<string, unknown>) => void;
}

export interface SlaReport {
  tenantId: string;
  evaluated: number;
  breaches: number;
  atRisk: number;
  cleared: number;
  responseMissed: number;
  resolutionMissed: number;
}

const severityTargetSchema = z.object({
  respondMinutes: z.number().int().positive(),
  resolveMinutes: z.number().int().positive(),
});
const responseTargetsSchema = z.object({
  critical: severityTargetSchema.optional(),
  high: severityTargetSchema.optional(),
  medium: severityTargetSchema.optional(),
  low: severityTargetSchema.optional(),
  informational: severityTargetSchema.optional(),
});

/** The engine's view of an SLA row: the stored JSON targets validated, unknown shapes dropped. */
export function slaDefinitionOf(row: {
  id: string;
  name: string;
  availabilityTargetPercent: number;
  window: SlaWindow;
  responseTargets: unknown;
  burnRateAlert: number;
}): SlaDefinition {
  const parsed = responseTargetsSchema.safeParse(row.responseTargets);
  const targets: Partial<SeverityTargets> = parsed.success ? (parsed.data as Partial<SeverityTargets>) : {};
  return {
    id: row.id,
    name: row.name,
    availabilityTargetPercent: row.availabilityTargetPercent,
    window: row.window,
    responseTargets: targets,
    burnRateAlert: row.burnRateAlert,
  };
}

export interface ApplyReport {
  cisSeen: number;
  healthChanged: number;
  tenants: string[];
}

export interface RecomputeReport {
  tenantId: string;
  services: number;
  changed: number;
  incidentsOpened: number;
  incidentsResolved: number;
  deliveries: number;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function envelope(
  tenantId: string,
  type: EventType,
  subject: string,
  data: Record<string, unknown>,
  now: string,
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    specversion: '1.0',
    id: randomUUID(),
    source: ENGINE_SOURCE,
    type,
    subject,
    time: now,
    datacontenttype: 'application/json',
    dataschema: 'openmap/contracts/event/' + CONTRACT_VERSIONS.event,
    tenantid: tenantId,
    data,
  });
}

export function createEngine(deps: EngineDeps) {
  const { prisma, graph } = deps;

  async function healthMap(tenantId: string, ids: readonly string[]): Promise<Map<string, Health>> {
    if (ids.length === 0) return new Map();
    const rows = await graph.readOnly<{ id: string; health: Health | null }>(HEALTH_QUERY, {
      tenantId,
      ids: [...ids],
    });
    return new Map(rows.map((r) => [r.id, r.health ?? 'unknown']));
  }

  async function emit(
    tenantId: string,
    type: EventType,
    subject: string,
    data: Record<string, unknown>,
  ): Promise<EventEnvelope> {
    const e = envelope(tenantId, type, subject, data, deps.now());
    await prisma.outboxEvent.create({
      data: {
        eventId: e.id,
        tenantId,
        type: e.type,
        subject: e.subject,
        envelope: json(e),
        pending: ['clickhouse', 'websocket'],
      },
    });
    return e;
  }

  /** CI change events → CI health on the graph. Returns the tenants whose services need recomputation. */
  async function applyCiEvents(events: readonly EventEnvelope[]): Promise<ApplyReport> {
    const cis: Ci[] = [];
    for (const e of events) {
      if (!CI_EVENT_TYPES.has(e.type)) continue;
      const ci = (e.data as { ci?: Ci }).ci;
      if (ci) cis.push(ci);
    }
    const tenants = new Set<string>();
    let changed = 0;
    const byTenant = new Map<string, Ci[]>();
    for (const ci of cis) byTenant.set(ci.tenantId, [...(byTenant.get(ci.tenantId) ?? []), ci]);
    const now = deps.now();
    for (const [tenantId, list] of byTenant) {
      const current = await healthMap(
        tenantId,
        list.map((c) => c.id),
      );
      for (const ci of list) {
        // A probed inter-site link takes its health from its probes (ADR-025, readiness.ts), never from attributes.
        if (
          ci.type === 'site_link' &&
          typeof (ci.attributes as Record<string, unknown>)[CONNECTIVITY_ATTRIBUTES.probeTarget] === 'string'
        )
          continue;
        const verdict = deriveHealth(ci, now);
        if (current.get(ci.id) === verdict.health) continue;
        await graph.setHealth(tenantId, ci.id, verdict.health);
        changed++;
        tenants.add(tenantId);
      }
    }
    return { cisSeen: cis.length, healthChanged: changed, tenants: [...tenants] };
  }

  async function servicesOf(tenantId: string) {
    return prisma.ci.findMany({
      where: { tenantId, type: SERVICE_TYPE, validTo: null },
      select: { id: true, displayName: true, attributes: true },
    });
  }

  /** SLA assigned to each service of the tenant (ADR-024). */
  async function assignmentsOf(tenantId: string): Promise<Map<string, SlaDefinition>> {
    const rows = await prisma.serviceSlaAssignment.findMany({ where: { tenantId }, include: { sla: true } });
    return new Map(rows.map((r) => [r.serviceCiId, slaDefinitionOf(r.sla)]));
  }

  async function timeZoneOf(tenantId: string): Promise<string> {
    const settings = await prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { timeZone: true },
    });
    return settings?.timeZone ?? TENANT_SETTINGS_DEFAULTS.timeZone;
  }

  async function modelsFor(tenantId: string, serviceIds: readonly string[]): Promise<ServiceModel[]> {
    const rels = await prisma.relationship.findMany({
      where: { tenantId, type: PART_OF_SERVICE, validTo: null, toCiId: { in: [...serviceIds] } },
      select: { fromCiId: true, toCiId: true },
    });
    const members = await prisma.ci.findMany({
      where: { id: { in: [...new Set(rels.map((r) => r.fromCiId))] }, validTo: null },
      select: { id: true, attributes: true },
    });
    const memberById = new Map(members.map((m) => [m.id, m]));
    return serviceIds.map((serviceCiId) => {
      const groups = new Map<string, { memberCiIds: string[]; minHealthy: number }>();
      for (const r of rels) {
        if (r.toCiId !== serviceCiId) continue;
        const member = memberById.get(r.fromCiId);
        if (!member) continue;
        const attrs = member.attributes as Record<string, unknown>;
        const name = str(attrs[ATTR.redundancyGroup]) ?? member.id;
        const group = groups.get(name) ?? { memberCiIds: [], minHealthy: 1 };
        group.memberCiIds.push(member.id);
        group.minHealthy = Math.max(group.minHealthy, num(attrs[ATTR.minHealthy]) ?? 1);
        groups.set(name, group);
      }
      return { serviceCiId, groups: [...groups.entries()].map(([name, g]) => ({ name, ...g })) };
    });
  }

  /**
   * Members the graph has never scored (health unknown) are scored from their stored snapshot, so
   * services converge after a restart or a replay without waiting for the next observation.
   */
  async function refreshUnknownMembers(
    tenantId: string,
    memberIds: readonly string[],
    health: Map<string, Health>,
  ): Promise<void> {
    const unknown = [...new Set(memberIds)].filter((id) => (health.get(id) ?? 'unknown') === 'unknown');
    if (unknown.length === 0) return;
    const rows = await prisma.ci.findMany({
      where: { tenantId, id: { in: unknown }, validTo: null },
      select: { id: true, type: true, attributes: true, observedAt: true, lifecycle: true },
    });
    const now = deps.now();
    for (const row of rows) {
      const verdict = deriveHealth(
        {
          type: row.type,
          attributes: row.attributes as Ci['attributes'],
          observedAt: row.observedAt.toISOString(),
          lifecycle: row.lifecycle,
        },
        now,
      );
      if (verdict.health === 'unknown') continue;
      await graph.setHealth(tenantId, row.id, verdict.health);
      health.set(row.id, verdict.health);
    }
  }

  async function openIncidents(tenantId: string, serviceIds: readonly string[]): Promise<OpenIncident[]> {
    const rows = await prisma.incident.findMany({
      where: {
        tenantId,
        source: SOURCE_NAME,
        state: { in: [...ACTIVE_INCIDENT_STATES] },
        affectedServiceCiIds: { hasSome: [...serviceIds] },
      },
    });
    return rows.flatMap((r) =>
      r.affectedServiceCiIds
        .filter((s) => serviceIds.includes(s))
        .map((serviceCiId) => ({
          id: r.id,
          serviceCiId,
          severity: r.severity,
          rootCauseCiId: r.rootCauseCiId,
        })),
    );
  }

  async function deliverIncident(
    tenantId: string,
    incidentId: string,
    view: IncidentView,
    type: EventType,
    eventId: string,
  ): Promise<number> {
    const rows = await prisma.integrationConfig.findMany({
      where: {
        tenantId,
        enabled: true,
        subscribedEvents: { has: type },
        direction: { in: ['outbound', 'bidirectional'] },
        // REQ-INT-009 (ADR-065): webhook, Slack, Teams and email receive incidents as notifications instead.
        vendor: { notIn: NOTIFICATION_VENDORS.filter((v) => v !== 'pagerduty') },
      },
    });
    let delivered = 0;
    for (const row of rows) {
      const parsed = integrationConfigSchema.safeParse({
        ...row,
        settings: row.settings ?? {},
        fieldMappings: row.fieldMappings ?? [],
        classMappings: row.classMappings ?? [],
        schedule: row.scheduleCron ? { cron: row.scheduleCron } : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
      if (!parsed.success) {
        deps.log({ msg: 'integration config invalid', integrationId: row.id, error: parsed.error.message });
        continue;
      }
      const config: IntegrationConfig = parsed.data;
      let headers: Record<string, string>;
      try {
        const cred = await deps.secrets.read(config.credentialRef);
        headers = authHeaders(config.vendor, cred.fields);
      } catch (err) {
        deps.log({
          msg: 'credential unavailable',
          integrationId: config.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const req = incidentRequest(view, config);
      const outcome = await deliver(
        { config, path: req.path, method: req.method, headers, body: req.body, eventId },
        deps.delivery,
      );
      const d = outcome.delivery;
      await prisma.integrationDelivery.create({
        data: {
          id: d.id,
          tenantId,
          integrationId: config.id,
          direction: d.direction,
          eventId: d.eventId,
          remoteId: d.remoteId,
          state: d.state,
          attempts: d.attempts,
          requestDigest: d.requestDigest,
          responseCode: d.responseCode,
          error: d.error,
          createdAt: new Date(d.createdAt),
          completedAt: d.completedAt ? new Date(d.completedAt) : null,
        },
      });
      if (outcome.remoteId) {
        await prisma.incidentLink.upsert({
          where: { incidentId_integrationId: { incidentId, integrationId: config.id } },
          update: {
            remoteId: outcome.remoteId,
            remoteUrl: remoteUrlFor(config, outcome.remoteId),
            remoteState: 'open',
            syncedAt: new Date(deps.now()),
          },
          create: {
            incidentId,
            integrationId: config.id,
            tenantId,
            remoteId: outcome.remoteId,
            remoteUrl: remoteUrlFor(config, outcome.remoteId),
            remoteState: 'open',
            syncedAt: new Date(deps.now()),
          },
        });
      }
      delivered++;
    }
    return delivered;
  }

  /** Recomputes every business service of a tenant and acts on the ones whose state changed. */
  async function recomputeTenant(tenantId: string): Promise<RecomputeReport> {
    const services = await servicesOf(tenantId);
    const report: RecomputeReport = {
      tenantId,
      services: services.length,
      changed: 0,
      incidentsOpened: 0,
      incidentsResolved: 0,
      deliveries: 0,
    };
    if (services.length === 0) return report;
    const serviceIds = services.map((s) => s.id);
    const models = await modelsFor(tenantId, serviceIds);
    const memberIds = models.flatMap((m) => m.groups.flatMap((g) => g.memberCiIds));
    const health = await healthMap(tenantId, [...new Set([...memberIds, ...serviceIds])]);
    await refreshUnknownMembers(tenantId, memberIds, health);
    const previous = new Map(serviceIds.map((id) => [id, health.get(id) ?? 'unknown'] as const));
    const { changed } = propagateAll(models, health, previous);
    if (changed.length === 0) return report;
    report.changed = changed.length;
    const summaries = new Map<string, ServiceSummary>(
      services.map((s) => {
        const attrs = s.attributes as Record<string, unknown>;
        return [
          s.id,
          { serviceCiId: s.id, name: s.displayName, tier: num(attrs[ATTR.tier]) ?? ITSM.priorityMedium },
        ];
      }),
    );
    const now = deps.now();
    for (const state of changed) {
      await graph.setHealth(tenantId, state.serviceCiId, state.state);
      await emit(tenantId, HEALTH_CHANGED, state.serviceCiId, {
        serviceId: state.serviceCiId,
        state: state.state,
        previous: previous.get(state.serviceCiId) ?? 'unknown',
        rootCauseIds: state.rootCauseCiIds,
        groups: state.groups,
        budgetRemainingMinutes: null,
      });
    }
    const actions = incidentActions(
      changed,
      await openIncidents(
        tenantId,
        changed.map((c) => c.serviceCiId),
      ),
      summaries,
    );
    const rootNames = new Map(
      (
        await prisma.ci.findMany({
          where: { id: { in: actions.flatMap((a) => ('rootCauseCiIds' in a ? a.rootCauseCiIds : [])) } },
          select: { id: true, displayName: true },
        })
      ).map((c) => [c.id, c.displayName]),
    );
    const assignments = actions.some((a) => a.kind === 'open')
      ? await assignmentsOf(tenantId)
      : new Map<string, SlaDefinition>();
    for (const action of actions) {
      if (action.kind === 'open') {
        const service = services.find((s) => s.id === action.serviceCiId);
        const attrs = (service?.attributes ?? {}) as Record<string, unknown>;
        const sla = assignments.get(action.serviceCiId) ?? null;
        const targets = targetsFor(sla, action.severity, now);
        const incident = await prisma.incident.create({
          data: {
            tenantId,
            title: action.title,
            description: action.description,
            severity: action.severity,
            state: 'open',
            source: SOURCE_NAME,
            affectedServiceCiIds: [action.serviceCiId],
            rootCauseCiId: action.rootCauseCiIds[0] ?? null,
            correlatedEventIds: [],
            openedAt: new Date(now),
            slaId: sla?.id ?? null,
            respondBy: new Date(targets.respondBy),
            resolveBy: new Date(targets.resolveBy),
          },
        });
        report.incidentsOpened++;
        const e = await emit(tenantId, INCIDENT_OPENED, incident.id, {
          incidentId: incident.id,
          serviceId: action.serviceCiId,
          severity: action.severity,
          state: action.state,
          rootCauseIds: action.rootCauseCiIds,
          title: action.title,
        });
        const view: IncidentView = {
          id: incident.id,
          tenantId,
          serviceName: summaries.get(action.serviceCiId)?.name ?? action.serviceCiId,
          serviceTier: summaries.get(action.serviceCiId)?.tier ?? ITSM.priorityMedium,
          state: action.state,
          openedAt: now,
          rootCauseName: action.rootCauseCiIds[0] ? (rootNames.get(action.rootCauseCiIds[0]) ?? null) : null,
          rootCauseCiId: action.rootCauseCiIds[0] ?? null,
          affectedCiIds: action.rootCauseCiIds,
          alertCount: 1,
          usersAffected: num(attrs[ATTR.usersAffected]),
          ownerTeams: strings(attrs[ATTR.ownerTeams]),
          summary: action.description,
        };
        report.deliveries += await deliverIncident(tenantId, incident.id, view, INCIDENT_OPENED, e.id);
      } else if (action.kind === 'update') {
        await prisma.incident.update({
          where: { id: action.incidentId },
          data: { severity: action.severity, rootCauseCiId: action.rootCauseCiIds[0] ?? null },
        });
        await emit(tenantId, INCIDENT_UPDATED, action.incidentId, {
          incidentId: action.incidentId,
          severity: action.severity,
          rootCauseIds: action.rootCauseCiIds,
        });
      } else if (action.kind === 'mitigate') {
        await prisma.incident.update({ where: { id: action.incidentId }, data: { state: 'mitigated' } });
        await emit(tenantId, INCIDENT_UPDATED, action.incidentId, {
          incidentId: action.incidentId,
          serviceId: action.serviceCiId,
          state: 'mitigated',
        });
      } else {
        await prisma.incident.update({
          where: { id: action.incidentId },
          data: { state: 'resolved', resolvedAt: new Date(now) },
        });
        await prisma.incidentLink.updateMany({
          where: { incidentId: action.incidentId },
          data: { remoteState: 'resolved', syncedAt: new Date(now) },
        });
        report.incidentsResolved++;
        await emit(tenantId, INCIDENT_RESOLVED, action.incidentId, {
          incidentId: action.incidentId,
          serviceId: action.serviceCiId,
        });
      }
    }
    return report;
  }

  /** The service health view integrations receive for an SLA-breach or target-missed incident. */
  function slaIncidentView(
    tenantId: string,
    incident: {
      id: string;
      description: string;
      title: string;
      openedAt: Date;
      rootCauseCiId: string | null;
      affectedServiceCiIds: string[];
      correlatedEventIds: string[];
    },
    summary: ServiceSummary | undefined,
    health: Health,
    attrs: Record<string, unknown>,
  ): IncidentView {
    return {
      id: incident.id,
      tenantId,
      serviceName: summary?.name ?? incident.affectedServiceCiIds[0] ?? '',
      serviceTier: summary?.tier ?? ITSM.priorityMedium,
      state: health === 'down' ? 'down' : 'degraded',
      openedAt: incident.openedAt.toISOString(),
      rootCauseName: null,
      rootCauseCiId: incident.rootCauseCiId,
      affectedCiIds: incident.affectedServiceCiIds,
      alertCount: Math.max(1, incident.correlatedEventIds.length),
      usersAffected: num(attrs[ATTR.usersAffected]),
      ownerTeams: strings(attrs[ATTR.ownerTeams]),
      summary: incident.description.length > 0 ? incident.description : incident.title,
    };
  }

  /**
   * Evaluates every SLA-assigned service of the tenant over its current window from the health history, opens a breach
   * incident when the budget is exhausted, raises one at-risk alert per window at the burn-rate threshold, closes a
   * breach incident once a new window is within budget, and stamps open incidents whose response or resolution target
   * passed (REQ-BSM-006, ADR-024).
   */
  async function evaluateSlas(tenantId: string): Promise<SlaReport> {
    const report: SlaReport = {
      tenantId,
      evaluated: 0,
      breaches: 0,
      atRisk: 0,
      cleared: 0,
      responseMissed: 0,
      resolutionMissed: 0,
    };
    const now = deps.now();
    const assignments = await assignmentsOf(tenantId);
    if (assignments.size > 0) {
      const services = await servicesOf(tenantId);
      const timeZone = await timeZoneOf(tenantId);
      const assigned = services.filter((s) => assignments.has(s.id));
      const ids = assigned.map((s) => s.id);
      const windows = new Map(
        assigned.map((s) => [s.id, slaWindowAt(assignments.get(s.id)!.window, now, timeZone)] as const),
      );
      const earliest = [...windows.values()].reduce(
        (min, w) => (Date.parse(w.start) < Date.parse(min) ? w.start : min),
        now,
      );
      const [history, before, health, openRows, atRiskRows] = await Promise.all([
        deps.history.changes(tenantId, ids, earliest),
        deps.history.stateBefore(tenantId, ids, earliest),
        healthMap(tenantId, ids),
        prisma.incident.findMany({
          where: {
            tenantId,
            source: SLA_SOURCE,
            state: { in: [...ACTIVE_INCIDENT_STATES] },
            affectedServiceCiIds: { hasSome: ids },
          },
          select: { id: true, openedAt: true, affectedServiceCiIds: true },
        }),
        prisma.outboxEvent.findMany({
          where: {
            tenantId,
            type: SLA_AT_RISK,
            subject: { in: ids },
            createdAt: { gte: new Date(earliest) },
          },
          select: { subject: true, createdAt: true },
        }),
      ]);
      const inputs: SlaServiceInput[] = assigned.map((s) => {
        const sla = assignments.get(s.id)!;
        const window = windows.get(s.id)!;
        const changes = changesOf(history, s.id);
        const initial =
          before.get(s.id) ?? (changes.length === 0 ? (health.get(s.id) ?? 'unknown') : 'healthy');
        const figures = availabilityIn(changes, initial, window, now);
        const attrs = s.attributes as Record<string, unknown>;
        const open = openRows.find((r) => r.affectedServiceCiIds.includes(s.id));
        return {
          serviceCiId: s.id,
          name: s.displayName,
          tier: num(attrs[ATTR.tier]) ?? ITSM.priorityMedium,
          sla,
          window,
          figures,
          budget: windowBudget(sla.availabilityTargetPercent, window, figures, now),
          openIncident: open ? { id: open.id, openedAt: open.openedAt.toISOString() } : null,
          atRiskRaised: atRiskRows.some(
            (r) => r.subject === s.id && r.createdAt.getTime() >= Date.parse(window.start),
          ),
        };
      });
      report.evaluated = inputs.length;
      const summaries = new Map<string, ServiceSummary>(
        assigned.map((s) => [
          s.id,
          {
            serviceCiId: s.id,
            name: s.displayName,
            tier: num((s.attributes as Record<string, unknown>)[ATTR.tier]) ?? ITSM.priorityMedium,
          },
        ]),
      );
      for (const action of slaActions(inputs, now)) {
        if (action.kind === 'breach') {
          const sla = assignments.get(action.serviceCiId)!;
          const targets = targetsFor(sla, action.severity, now);
          const incident = await prisma.incident.create({
            data: {
              tenantId,
              title: action.title,
              description: action.description,
              severity: action.severity,
              state: 'open',
              source: SLA_SOURCE,
              affectedServiceCiIds: [action.serviceCiId],
              rootCauseCiId: null,
              correlatedEventIds: [],
              openedAt: new Date(now),
              slaId: action.slaId,
              respondBy: new Date(targets.respondBy),
              resolveBy: new Date(targets.resolveBy),
            },
          });
          report.breaches++;
          await emit(tenantId, SLA_BREACHED, action.serviceCiId, {
            serviceId: action.serviceCiId,
            slaId: action.slaId,
            incidentId: incident.id,
            budgetMinutes: action.budget.budgetMinutes,
            consumedMinutes: action.budget.consumedMinutes,
            windowStart: windows.get(action.serviceCiId)?.start ?? null,
          });
          const e = await emit(tenantId, INCIDENT_OPENED, incident.id, {
            incidentId: incident.id,
            serviceId: action.serviceCiId,
            severity: action.severity,
            state: 'breached',
            rootCauseIds: [],
            title: action.title,
            slaId: action.slaId,
          });
          const service = assigned.find((s) => s.id === action.serviceCiId);
          await deliverIncident(
            tenantId,
            incident.id,
            slaIncidentView(
              tenantId,
              incident,
              summaries.get(action.serviceCiId),
              health.get(action.serviceCiId) ?? 'unknown',
              (service?.attributes ?? {}) as Record<string, unknown>,
            ),
            INCIDENT_OPENED,
            e.id,
          );
        } else if (action.kind === 'at_risk') {
          report.atRisk++;
          await emit(tenantId, SLA_AT_RISK, action.serviceCiId, {
            serviceId: action.serviceCiId,
            slaId: action.slaId,
            burnRate: action.burnRate,
            remainingMinutes: action.remainingMinutes,
            forecastAt: action.forecastAt,
          });
        } else {
          await prisma.incident.update({
            where: { id: action.incidentId },
            data: { state: 'resolved', resolvedAt: new Date(now), resolutionNote: WINDOW_ROLLED_NOTE },
          });
          report.cleared++;
          await emit(tenantId, INCIDENT_RESOLVED, action.incidentId, {
            incidentId: action.incidentId,
            serviceId: action.serviceCiId,
            by: ENGINE_SOURCE,
          });
        }
      }
    }
    // Response and resolution targets of every open incident, whatever opened it.
    const open = await prisma.incident.findMany({
      where: {
        tenantId,
        state: { in: [...ACTIVE_INCIDENT_STATES] },
        OR: [{ respondBy: { not: null } }, { resolveBy: { not: null } }],
      },
    });
    const breaches = targetBreaches(
      open.map((i) => ({
        id: i.id,
        acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null,
        resolvedAt: i.resolvedAt?.toISOString() ?? null,
        respondBy: i.respondBy?.toISOString() ?? null,
        resolveBy: i.resolveBy?.toISOString() ?? null,
        responseBreachedAt: i.responseBreachedAt?.toISOString() ?? null,
        resolutionBreachedAt: i.resolutionBreachedAt?.toISOString() ?? null,
      })),
      now,
    );
    if (breaches.length > 0) {
      const serviceIds = [...new Set(open.flatMap((i) => i.affectedServiceCiIds))];
      const services = await prisma.ci.findMany({
        where: { tenantId, id: { in: serviceIds } },
        select: { id: true, displayName: true, attributes: true },
      });
      const health = await healthMap(tenantId, serviceIds);
      for (const b of breaches) {
        const incident = open.find((i) => i.id === b.incidentId);
        if (!incident) continue;
        const data =
          b.kind === 'response'
            ? { responseBreachedAt: new Date(now) }
            : { resolutionBreachedAt: new Date(now) };
        await prisma.incident.update({ where: { id: b.incidentId }, data });
        if (b.kind === 'response') report.responseMissed++;
        else report.resolutionMissed++;
        const e = await emit(tenantId, INCIDENT_UPDATED, b.incidentId, {
          incidentId: b.incidentId,
          serviceId: incident.affectedServiceCiIds[0] ?? null,
          action: b.kind === 'response' ? 'response_target_missed' : 'resolution_target_missed',
          by: ENGINE_SOURCE,
        });
        const service = services.find((s) => incident.affectedServiceCiIds.includes(s.id));
        const attrs = (service?.attributes ?? {}) as Record<string, unknown>;
        const summary: ServiceSummary | undefined = service
          ? {
              serviceCiId: service.id,
              name: service.displayName,
              tier: num(attrs[ATTR.tier]) ?? ITSM.priorityMedium,
            }
          : undefined;
        await deliverIncident(
          tenantId,
          incident.id,
          slaIncidentView(
            tenantId,
            incident,
            summary,
            service ? (health.get(service.id) ?? 'unknown') : 'unknown',
            attrs,
          ),
          INCIDENT_UPDATED,
          e.id,
        );
      }
    }
    return report;
  }

  return { applyCiEvents, recomputeTenant, evaluateSlas, healthMap };
}

export type Engine = ReturnType<typeof createEngine>;
export type { ServiceState };
