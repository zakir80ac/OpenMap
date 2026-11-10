// REQ-BSM-007 (ADR-025) — the continuous HA / DR readiness evaluation of one tenant:
// - reads its site and site_link CIs and each link's latest probe samples (ClickHouse metrics_latest);
// - sets each probed link's health on the graph;
// - evaluates the readiness rules;
// - opens a finding and an incident for every new breach, and clears the finding and resolves the incident when the
//   breach is gone.
// REQ-IPAM-007 (ADR-069): network circuits under the links:
// - a link that is not probed takes its health from the carrier circuits it rides on (depends_on), each taken down by a
//   down hand-off port at either end;
// - `path_diversity` raises a link that shares a provider, a route or a carrier circuit with another link between the
//   same sites;
// - `redundancy_lost` raises a link down between two sites that had more than one path, and its incident names the
//   business services the impact graph reaches from the link, like the outage of every other component.
import { CONNECTIVITY_ATTRIBUTES, LINK_CIRCUIT_RELATIONSHIP, LINK_METRICS, LINK_METRIC_NAMES, SITE_DR_ROLES, type EventType, type ReadinessRule, type SiteDrRole } from '@openmap/contracts';
import { GRAPH, LINK_CIRCUITS, READINESS } from '@openmap/constants';
import type { PrismaClient } from '@openmap/db';
import type { GraphRepository } from '@openmap/graph';
import { withSpan } from '@openmap/telemetry';
import { circuitHealth, linkHealthFromCircuits, pathDiversityBreaches, redundancyLostBreaches, type CircuitLink } from '../core/circuits.js';
import { breachKey, evaluateReadiness, linkHealth, type Breach, type LatestSample, type LinkSnapshot, type SiteSnapshot } from '../core/readiness.js';
import type { Health } from '../core/propagate.js';
import { envelope, INCIDENT_OPENED, INCIDENT_RESOLVED } from './engine.js';

export type ClickHouseQuery = (name: string, sql: string, params: Record<string, unknown>) => Promise<unknown[]>;

export interface ReadinessDeps {
  prisma: PrismaClient;
  graph: GraphRepository;
  query: ClickHouseQuery;
  database: string;
  healthMap: (tenantId: string, ids: readonly string[]) => Promise<Map<string, Health>>;
  probeIntervalMs: number;
  now: () => string;
}

export interface ReadinessReport {
  links: number;
  linkHealthChanged: number;
  opened: number;
  cleared: number;
  /** REQ-IPAM-007: findings opened and cleared, by rule, for the findings counter. */
  openedByRule: Partial<Record<ReadinessRule, number>>;
  clearedByRule: Partial<Record<ReadinessRule, number>>;
}

/** The tracer the BSM engine's spans are named under (main.ts). */
const TRACER = 'openmap-bsm-engine';
/** Rules whose incident names the business services the impact graph reaches from the link (REQ-IPAM-007). */
const SERVICE_IMPACT_RULES: ReadonlySet<ReadinessRule> = new Set<ReadinessRule>(['redundancy_lost']);
const CONNECTED_TO = 'connected_to';
const CIRCUIT_TYPE = 'circuit';

function bump(counts: Partial<Record<ReadinessRule, number>>, rule: ReadinessRule): void {
  counts[rule] = (counts[rule] ?? 0) + 1;
}

interface LatestRow {
  ci: string;
  metric: string;
  v: number;
  ms: string | number;
}

const DR_ROLES: ReadonlySet<string> = new Set(SITE_DR_ROLES);

function attr(attributes: unknown, key: string): unknown {
  return attributes !== null && typeof attributes === 'object' ? (attributes as Record<string, unknown>)[key] : undefined;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function int(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function createReadiness(deps: ReadinessDeps) {
  const { prisma, graph } = deps;

  async function latest(tenantId: string, ids: readonly string[]): Promise<Map<string, Partial<Record<string, LatestSample>>>> {
    const out = new Map<string, Partial<Record<string, LatestSample>>>();
    if (ids.length === 0) return out;
    const rows = (await deps.query(
      'readiness_link_latest',
      // The id is aliased `ci`, not `ci_id`: ClickHouse applies SELECT aliases in WHERE, and a string alias would turn the
      // UUID filter into a string comparison that matches nothing.
      'SELECT toString(ci_id) AS ci, metric, argMax(value, ts) AS v, toUnixTimestamp64Milli(max(ts)) AS ms FROM ' +
        deps.database +
        '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND ci_id IN ({ids:Array(UUID)}) AND metric IN ({metrics:Array(String)}) GROUP BY ci_id, metric',
      { tenantId, ids: [...ids], metrics: [...LINK_METRIC_NAMES] },
    )) as LatestRow[];
    for (const r of rows) {
      const entry = out.get(r.ci) ?? {};
      entry[r.metric] = { value: Number(r.v), at: Number(r.ms) };
      out.set(r.ci, entry);
    }
    return out;
  }

  /**
   * REQ-IPAM-007 — the carrier circuits each link rides on, and each circuit's health: its own on the graph, taken down
   * by a down hand-off port (LINK_CIRCUITS.handOffTypes) at either of its ends.
   */
  async function circuitsOf(
    tenantId: string,
    linkIds: readonly string[],
  ): Promise<{ byLink: Map<string, string[]>; health: Map<string, Health>; names: Map<string, string> }> {
    const byLink = new Map<string, string[]>();
    const health = new Map<string, Health>();
    const names = new Map<string, string>();
    if (linkIds.length === 0) return { byLink, health, names };
    const rides = await prisma.relationship.findMany({
      where: { tenantId, type: LINK_CIRCUIT_RELATIONSHIP, validTo: null, fromCiId: { in: [...linkIds] }, toCi: { type: CIRCUIT_TYPE, validTo: null } },
      select: { fromCiId: true, toCiId: true, toCi: { select: { displayName: true } } },
    });
    for (const r of rides) {
      byLink.set(r.fromCiId, [...(byLink.get(r.fromCiId) ?? []), r.toCiId]);
      names.set(r.toCiId, r.toCi.displayName);
    }
    const circuitIds = [...names.keys()];
    if (circuitIds.length === 0) return { byLink, health, names };
    const handOffs = await prisma.relationship.findMany({
      where: { tenantId, type: CONNECTED_TO, validTo: null, fromCiId: { in: circuitIds }, toCi: { type: { in: [...LINK_CIRCUITS.handOffTypes] }, validTo: null } },
      select: { fromCiId: true, toCiId: true },
    });
    const known = await deps.healthMap(tenantId, [...circuitIds, ...handOffs.map((e) => e.toCiId)]);
    for (const id of circuitIds) {
      const atEnds = handOffs.filter((e) => e.fromCiId === id).map((e) => known.get(e.toCiId) ?? 'unknown');
      health.set(id, circuitHealth(known.get(id) ?? 'unknown', atEnds));
    }
    return { byLink, health, names };
  }

  /** REQ-IPAM-007 — the business services the impact graph reaches upstream from a CI. */
  async function servicesReached(tenantId: string, ciId: string): Promise<string[]> {
    const result = await graph.impact(tenantId, ciId, { direction: 'upstream', maxDepth: GRAPH.defaultImpactDepth, asOf: null, edgeTypes: [] });
    return [...new Set(result.services.map((s) => s.ci.id))];
  }

  async function emit(tenantId: string, type: EventType, subject: string, data: Record<string, unknown>): Promise<void> {
    const e = envelope(tenantId, type, subject, data, deps.now());
    await prisma.outboxEvent.create({ data: { eventId: e.id, tenantId, type: e.type, subject: e.subject, envelope: e as never, pending: ['clickhouse', 'websocket'] } });
  }

  async function evaluateTenant(tenantId: string): Promise<ReadinessReport> {
    const report: ReadinessReport = { links: 0, linkHealthChanged: 0, opened: 0, cleared: 0, openedByRule: {}, clearedByRule: {} };
    const [siteRows, linkRows] = await Promise.all([
      prisma.ci.findMany({ where: { tenantId, type: 'site', validTo: null }, select: { id: true, name: true, displayName: true, identity: true, attributes: true } }),
      prisma.ci.findMany({ where: { tenantId, type: 'site_link', validTo: null }, select: { id: true, name: true, displayName: true, identity: true, attributes: true } }),
    ]);
    report.links = linkRows.length;
    const sites: SiteSnapshot[] = siteRows.map((s) => {
      const role = text(attr(s.attributes, CONNECTIVITY_ATTRIBUTES.drRole));
      return {
        ciId: s.id,
        code: text(attr(s.identity, 'code')) ?? s.name,
        name: s.displayName,
        drRole: role !== null && DR_ROLES.has(role) ? (role as SiteDrRole) : 'none',
        criticality: int(attr(s.attributes, CONNECTIVITY_ATTRIBUTES.criticality)),
      };
    });
    const samples = await latest(tenantId, linkRows.map((l) => l.id));
    const links: LinkSnapshot[] = linkRows.map((l) => {
      const s = samples.get(l.id) ?? {};
      return {
        ciId: l.id,
        name: l.displayName,
        fromSite: text(attr(l.identity, CONNECTIVITY_ATTRIBUTES.fromSiteRef)) ?? text(attr(l.attributes, CONNECTIVITY_ATTRIBUTES.fromSiteRef)),
        toSite: text(attr(l.identity, CONNECTIVITY_ATTRIBUTES.toSiteRef)) ?? text(attr(l.attributes, CONNECTIVITY_ATTRIBUTES.toSiteRef)),
        replication: attr(l.attributes, CONNECTIVITY_ATTRIBUTES.replication) === true,
        diversePaths: int(attr(l.attributes, CONNECTIVITY_ATTRIBUTES.diversePaths)) ?? 1,
        slaLatencyMs: int(attr(l.attributes, CONNECTIVITY_ATTRIBUTES.slaLatencyMs)),
        probed: text(attr(l.attributes, CONNECTIVITY_ATTRIBUTES.probeTarget)) !== null,
        reachable: s[LINK_METRICS.reachable] ?? null,
        latencyMs: s[LINK_METRICS.latencyMs] ?? null,
        lossPercent: s[LINK_METRICS.lossPercent] ?? null,
      };
    });

    // Link health from the probes; a link with no probe target takes it from its carrier circuits (REQ-IPAM-007), and a
    // link with neither keeps the health its attributes give it.
    const now = Date.parse(deps.now());
    const linkIds = links.map((l) => l.ciId);
    const [current, circuits] = await Promise.all([
      deps.healthMap(tenantId, linkIds),
      withSpan(TRACER, 'bsm.readiness.circuits', { 'openmap.tenant_id': tenantId, 'openmap.links': links.length }, () => circuitsOf(tenantId, linkIds)),
    ]);
    const health = new Map<string, Health>();
    for (const link of links) {
      const fromCircuits = link.probed ? null : linkHealthFromCircuits((circuits.byLink.get(link.ciId) ?? []).map((id) => circuits.health.get(id) ?? 'unknown'));
      if (!link.probed && fromCircuits === null) {
        health.set(link.ciId, current.get(link.ciId) ?? 'unknown');
        continue;
      }
      const verdict = fromCircuits ?? linkHealth(link, now, deps.probeIntervalMs);
      health.set(link.ciId, verdict);
      if (current.get(link.ciId) !== verdict) {
        await graph.setHealth(tenantId, link.ciId, verdict);
        report.linkHealthChanged += 1;
      }
    }

    const rowById = new Map(linkRows.map((l) => [l.id, l]));
    const circuitLinks: CircuitLink[] = links.map((l) => {
      const attributes = rowById.get(l.ciId)?.attributes;
      return {
        ciId: l.ciId,
        name: l.name,
        fromSite: l.fromSite,
        toSite: l.toSite,
        role: text(attr(attributes, CONNECTIVITY_ATTRIBUTES.role)),
        provider: text(attr(attributes, CONNECTIVITY_ATTRIBUTES.provider)),
        pathRef: text(attr(attributes, CONNECTIVITY_ATTRIBUTES.pathRef)),
        circuitCiIds: circuits.byLink.get(l.ciId) ?? [],
        diversePaths: l.diversePaths,
        health: health.get(l.ciId) ?? 'unknown',
      };
    });
    const breaches: Breach[] = [
      ...evaluateReadiness(sites, links, health),
      ...pathDiversityBreaches(circuitLinks, (id) => circuits.names.get(id) ?? id),
      ...redundancyLostBreaches(circuitLinks),
    ];
    const open = await prisma.readinessFinding.findMany({ where: { tenantId, state: 'open' } });
    const openKeys = new Map(open.map((f) => [breachKey({ rule: f.rule as Breach['rule'], subjectCiId: f.subjectCiId }), f]));
    const breachKeys = new Set(breaches.map(breachKey));
    const at = deps.now();
    for (const b of breaches) {
      if (openKeys.has(breachKey(b))) continue;
      const affectedServiceCiIds = SERVICE_IMPACT_RULES.has(b.rule) ? await servicesReached(tenantId, b.subjectCiId) : [];
      const incident = await prisma.incident.create({
        data: {
          tenantId,
          title: 'Readiness: ' + b.detail,
          description: b.detail,
          severity: READINESS.severity[b.rule],
          state: 'open',
          source: READINESS.incidentSource,
          affectedServiceCiIds,
          rootCauseCiId: b.subjectCiId,
          correlatedEventIds: [],
          openedAt: new Date(at),
        },
      });
      await prisma.readinessFinding.create({ data: { tenantId, rule: b.rule, subjectCiId: b.subjectCiId, state: 'open', detail: b.detail, openedAt: new Date(at), incidentId: incident.id } });
      await emit(tenantId, INCIDENT_OPENED, incident.id, { incidentId: incident.id, rule: b.rule, subjectCiId: b.subjectCiId, source: READINESS.incidentSource });
      report.opened += 1;
      bump(report.openedByRule, b.rule);
    }
    for (const [key, finding] of openKeys) {
      if (breachKeys.has(key)) continue;
      await prisma.readinessFinding.update({ where: { id: finding.id }, data: { state: 'cleared', clearedAt: new Date(at) } });
      if (finding.incidentId !== null) {
        await prisma.incident.updateMany({ where: { id: finding.incidentId, state: { in: ['open', 'acknowledged', 'mitigated'] } }, data: { state: 'resolved', resolvedAt: new Date(at), resolutionNote: 'Readiness restored: ' + finding.detail } });
        await emit(tenantId, INCIDENT_RESOLVED, finding.incidentId, { incidentId: finding.incidentId, rule: finding.rule, subjectCiId: finding.subjectCiId });
      }
      report.cleared += 1;
      bump(report.clearedByRule, finding.rule as ReadinessRule);
    }
    return report;
  }

  return { evaluateTenant };
}
