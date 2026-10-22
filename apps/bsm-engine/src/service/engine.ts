// REQ-BSM-001 REQ-BSM-002 REQ-BSM-003 REQ-INT-005 REQ-INT-006 — the running BSM engine: turns CI
// change events into CI health on the graph, propagates health through redundancy groups to
// business services, records health changes and SLA facts through the outbox, opens, updates and
// resolves incidents, and delivers them to the ITSM, SIEM and on-call integrations that subscribed.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS, ITSM } from '@openmap/constants';
import { eventEnvelopeSchema, integrationConfigSchema, type Ci, type EventEnvelope, type EventType, type IntegrationConfig } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import type { GraphRepository } from '@openmap/graph';
import { propagateAll, type Health, type ServiceModel, type ServiceState } from '../core/propagate.js';
import { deliver, type DeliveryDeps } from '../integrations/delivery.js';
import { authHeaders, incidentRequest, remoteUrlFor } from '../integrations/routes.js';
import type { IncidentView } from '../integrations/payloads.js';
import { deriveHealth } from './health-rules.js';
import { incidentActions, type OpenIncident, type ServiceSummary } from './incidents.js';

export const ENGINE_SOURCE = '/openmap/bsm-engine';
export const HEALTH_CHANGED: EventType = 'openmap.bsm.health.changed';
export const INCIDENT_OPENED: EventType = 'openmap.incident.opened';
export const INCIDENT_UPDATED: EventType = 'openmap.incident.updated';
export const INCIDENT_RESOLVED: EventType = 'openmap.incident.resolved';
const CI_EVENT_TYPES: ReadonlySet<string> = new Set(['openmap.ci.created', 'openmap.ci.updated', 'openmap.ci.labelled']);
const SERVICE_TYPE = 'business_service';
const PART_OF_SERVICE = 'part_of_service';
const ATTR = { tier: 'tier', usersAffected: 'usersAffected', ownerTeams: 'ownerTeams', redundancyGroup: 'redundancyGroup', minHealthy: 'minHealthy' } as const;
const HEALTH_QUERY = 'MATCH (c:Ci {tenantId: $tenantId}) WHERE c.id IN $ids RETURN c.id AS id, c.health AS health';
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
  now: () => string;
  log: (line: Record<string, unknown>) => void;
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

function envelope(tenantId: string, type: EventType, subject: string, data: Record<string, unknown>, now: string): EventEnvelope {
  return eventEnvelopeSchema.parse({
    specversion: '1.0', id: randomUUID(), source: ENGINE_SOURCE, type, subject, time: now, datacontenttype: 'application/json',
    dataschema: 'openmap/contracts/event/' + CONTRACT_VERSIONS.event, tenantid: tenantId, data,
  });
}

export function createEngine(deps: EngineDeps) {
  const { prisma, graph } = deps;

  async function healthMap(tenantId: string, ids: readonly string[]): Promise<Map<string, Health>> {
    if (ids.length === 0) return new Map();
    const rows = await graph.readOnly<{ id: string; health: Health | null }>(HEALTH_QUERY, { tenantId, ids: [...ids] });
    return new Map(rows.map((r) => [r.id, r.health ?? 'unknown']));
  }

  async function emit(tenantId: string, type: EventType, subject: string, data: Record<string, unknown>): Promise<EventEnvelope> {
    const e = envelope(tenantId, type, subject, data, deps.now());
    await prisma.outboxEvent.create({ data: { eventId: e.id, tenantId, type: e.type, subject: e.subject, envelope: json(e), pending: ['clickhouse', 'websocket'] } });
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
      const current = await healthMap(tenantId, list.map((c) => c.id));
      for (const ci of list) {
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
    return prisma.ci.findMany({ where: { tenantId, type: SERVICE_TYPE, validTo: null }, select: { id: true, displayName: true, attributes: true } });
  }

  async function modelsFor(tenantId: string, serviceIds: readonly string[]): Promise<ServiceModel[]> {
    const rels = await prisma.relationship.findMany({ where: { tenantId, type: PART_OF_SERVICE, validTo: null, toCiId: { in: [...serviceIds] } }, select: { fromCiId: true, toCiId: true } });
    const members = await prisma.ci.findMany({ where: { id: { in: [...new Set(rels.map((r) => r.fromCiId))] }, validTo: null }, select: { id: true, attributes: true } });
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
  async function refreshUnknownMembers(tenantId: string, memberIds: readonly string[], health: Map<string, Health>): Promise<void> {
    const unknown = [...new Set(memberIds)].filter((id) => (health.get(id) ?? 'unknown') === 'unknown');
    if (unknown.length === 0) return;
    const rows = await prisma.ci.findMany({ where: { tenantId, id: { in: unknown }, validTo: null }, select: { id: true, type: true, attributes: true, observedAt: true, lifecycle: true } });
    const now = deps.now();
    for (const row of rows) {
      const verdict = deriveHealth({ type: row.type, attributes: row.attributes as Ci['attributes'], observedAt: row.observedAt.toISOString(), lifecycle: row.lifecycle }, now);
      if (verdict.health === 'unknown') continue;
      await graph.setHealth(tenantId, row.id, verdict.health);
      health.set(row.id, verdict.health);
    }
  }

  async function openIncidents(tenantId: string, serviceIds: readonly string[]): Promise<OpenIncident[]> {
    const rows = await prisma.incident.findMany({ where: { tenantId, source: SOURCE_NAME, state: { in: [...ACTIVE_INCIDENT_STATES] }, affectedServiceCiIds: { hasSome: [...serviceIds] } } });
    return rows.flatMap((r) => r.affectedServiceCiIds.filter((s) => serviceIds.includes(s)).map((serviceCiId) => ({ id: r.id, serviceCiId, severity: r.severity, rootCauseCiId: r.rootCauseCiId })));
  }

  async function deliverIncident(tenantId: string, incidentId: string, view: IncidentView, type: EventType, eventId: string): Promise<number> {
    const rows = await prisma.integrationConfig.findMany({ where: { tenantId, enabled: true, subscribedEvents: { has: type }, direction: { in: ['outbound', 'bidirectional'] } } });
    let delivered = 0;
    for (const row of rows) {
      const parsed = integrationConfigSchema.safeParse({
        ...row, settings: row.settings ?? {}, fieldMappings: row.fieldMappings ?? [], classMappings: row.classMappings ?? [],
        schedule: row.scheduleCron ? { cron: row.scheduleCron } : null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
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
        deps.log({ msg: 'credential unavailable', integrationId: config.id, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const req = incidentRequest(view, config);
      const outcome = await deliver({ config, path: req.path, method: req.method, headers, body: req.body, eventId }, deps.delivery);
      const d = outcome.delivery;
      await prisma.integrationDelivery.create({
        data: { id: d.id, tenantId, integrationId: config.id, direction: d.direction, eventId: d.eventId, remoteId: d.remoteId, state: d.state, attempts: d.attempts, requestDigest: d.requestDigest, responseCode: d.responseCode, error: d.error, createdAt: new Date(d.createdAt), completedAt: d.completedAt ? new Date(d.completedAt) : null },
      });
      if (outcome.remoteId) {
        await prisma.incidentLink.upsert({
          where: { incidentId_integrationId: { incidentId, integrationId: config.id } },
          update: { remoteId: outcome.remoteId, remoteUrl: remoteUrlFor(config, outcome.remoteId), remoteState: 'open', syncedAt: new Date(deps.now()) },
          create: { incidentId, integrationId: config.id, tenantId, remoteId: outcome.remoteId, remoteUrl: remoteUrlFor(config, outcome.remoteId), remoteState: 'open', syncedAt: new Date(deps.now()) },
        });
      }
      delivered++;
    }
    return delivered;
  }

  /** Recomputes every business service of a tenant and acts on the ones whose state changed. */
  async function recomputeTenant(tenantId: string): Promise<RecomputeReport> {
    const services = await servicesOf(tenantId);
    const report: RecomputeReport = { tenantId, services: services.length, changed: 0, incidentsOpened: 0, incidentsResolved: 0, deliveries: 0 };
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
    const summaries = new Map<string, ServiceSummary>(services.map((s) => {
      const attrs = s.attributes as Record<string, unknown>;
      return [s.id, { serviceCiId: s.id, name: s.displayName, tier: num(attrs[ATTR.tier]) ?? ITSM.priorityMedium }];
    }));
    const now = deps.now();
    for (const state of changed) {
      await graph.setHealth(tenantId, state.serviceCiId, state.state);
      await emit(tenantId, HEALTH_CHANGED, state.serviceCiId, { serviceId: state.serviceCiId, state: state.state, previous: previous.get(state.serviceCiId) ?? 'unknown', rootCauseIds: state.rootCauseCiIds, groups: state.groups });
    }
    const actions = incidentActions(changed, await openIncidents(tenantId, changed.map((c) => c.serviceCiId)), summaries);
    const rootNames = new Map((await prisma.ci.findMany({ where: { id: { in: actions.flatMap((a) => ('rootCauseCiIds' in a ? a.rootCauseCiIds : [])) } }, select: { id: true, displayName: true } })).map((c) => [c.id, c.displayName]));
    for (const action of actions) {
      if (action.kind === 'open') {
        const service = services.find((s) => s.id === action.serviceCiId);
        const attrs = (service?.attributes ?? {}) as Record<string, unknown>;
        const incident = await prisma.incident.create({
          data: { tenantId, title: action.title, description: action.description, severity: action.severity, state: 'open', source: SOURCE_NAME, affectedServiceCiIds: [action.serviceCiId], rootCauseCiId: action.rootCauseCiIds[0] ?? null, correlatedEventIds: [], openedAt: new Date(now) },
        });
        report.incidentsOpened++;
        const e = await emit(tenantId, INCIDENT_OPENED, incident.id, { incidentId: incident.id, serviceId: action.serviceCiId, severity: action.severity, state: action.state, rootCauseIds: action.rootCauseCiIds, title: action.title });
        const view: IncidentView = {
          id: incident.id, tenantId, serviceName: summaries.get(action.serviceCiId)?.name ?? action.serviceCiId, serviceTier: summaries.get(action.serviceCiId)?.tier ?? ITSM.priorityMedium, state: action.state, openedAt: now,
          rootCauseName: action.rootCauseCiIds[0] ? (rootNames.get(action.rootCauseCiIds[0]) ?? null) : null, rootCauseCiId: action.rootCauseCiIds[0] ?? null, affectedCiIds: action.rootCauseCiIds,
          alertCount: 1, usersAffected: num(attrs[ATTR.usersAffected]), ownerTeams: strings(attrs[ATTR.ownerTeams]), summary: action.description,
        };
        report.deliveries += await deliverIncident(tenantId, incident.id, view, INCIDENT_OPENED, e.id);
      } else if (action.kind === 'update') {
        await prisma.incident.update({ where: { id: action.incidentId }, data: { severity: action.severity, rootCauseCiId: action.rootCauseCiIds[0] ?? null } });
        await emit(tenantId, INCIDENT_UPDATED, action.incidentId, { incidentId: action.incidentId, severity: action.severity, rootCauseIds: action.rootCauseCiIds });
      } else if (action.kind === 'mitigate') {
        await prisma.incident.update({ where: { id: action.incidentId }, data: { state: 'mitigated' } });
        await emit(tenantId, INCIDENT_UPDATED, action.incidentId, { incidentId: action.incidentId, serviceId: action.serviceCiId, state: 'mitigated' });
      } else {
        await prisma.incident.update({ where: { id: action.incidentId }, data: { state: 'resolved', resolvedAt: new Date(now) } });
        await prisma.incidentLink.updateMany({ where: { incidentId: action.incidentId }, data: { remoteState: 'resolved', syncedAt: new Date(now) } });
        report.incidentsResolved++;
        await emit(tenantId, INCIDENT_RESOLVED, action.incidentId, { incidentId: action.incidentId, serviceId: action.serviceCiId });
      }
    }
    return report;
  }

  return { applyCiEvents, recomputeTenant, healthMap };
}

export type Engine = ReturnType<typeof createEngine>;
export type { ServiceState };
