// REQ-BSM-007 (ADR-025) — the continuous HA / DR readiness evaluation of one tenant:
// - reads its site and site_link CIs and each link's latest probe samples (ClickHouse metrics_latest);
// - sets each probed link's health on the graph;
// - evaluates the readiness rules;
// - opens a finding and an incident for every new breach, and clears the finding and resolves the incident when the
//   breach is gone.
import { CONNECTIVITY_ATTRIBUTES, LINK_METRICS, LINK_METRIC_NAMES, SITE_DR_ROLES, type EventType, type SiteDrRole } from '@openmap/contracts';
import { READINESS } from '@openmap/constants';
import type { PrismaClient } from '@openmap/db';
import type { GraphRepository } from '@openmap/graph';
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

  async function emit(tenantId: string, type: EventType, subject: string, data: Record<string, unknown>): Promise<void> {
    const e = envelope(tenantId, type, subject, data, deps.now());
    await prisma.outboxEvent.create({ data: { eventId: e.id, tenantId, type: e.type, subject: e.subject, envelope: e as never, pending: ['clickhouse', 'websocket'] } });
  }

  async function evaluateTenant(tenantId: string): Promise<ReadinessReport> {
    const report: ReadinessReport = { links: 0, linkHealthChanged: 0, opened: 0, cleared: 0 };
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

    // Link health from the probes; a link with no probe target keeps the health its attributes give it.
    const now = Date.parse(deps.now());
    const current = await deps.healthMap(tenantId, links.map((l) => l.ciId));
    const health = new Map<string, Health>();
    for (const link of links) {
      if (!link.probed) {
        health.set(link.ciId, current.get(link.ciId) ?? 'unknown');
        continue;
      }
      const verdict = linkHealth(link, now, deps.probeIntervalMs);
      health.set(link.ciId, verdict);
      if (current.get(link.ciId) !== verdict) {
        await graph.setHealth(tenantId, link.ciId, verdict);
        report.linkHealthChanged += 1;
      }
    }

    const breaches = evaluateReadiness(sites, links, health);
    const open = await prisma.readinessFinding.findMany({ where: { tenantId, state: 'open' } });
    const openKeys = new Map(open.map((f) => [breachKey({ rule: f.rule as Breach['rule'], subjectCiId: f.subjectCiId }), f]));
    const breachKeys = new Set(breaches.map(breachKey));
    const at = deps.now();
    for (const b of breaches) {
      if (openKeys.has(breachKey(b))) continue;
      const incident = await prisma.incident.create({
        data: {
          tenantId,
          title: 'Readiness: ' + b.detail,
          description: b.detail,
          severity: READINESS.severity[b.rule],
          state: 'open',
          source: READINESS.incidentSource,
          affectedServiceCiIds: [],
          rootCauseCiId: b.subjectCiId,
          correlatedEventIds: [],
          openedAt: new Date(at),
        },
      });
      await prisma.readinessFinding.create({ data: { tenantId, rule: b.rule, subjectCiId: b.subjectCiId, state: 'open', detail: b.detail, openedAt: new Date(at), incidentId: incident.id } });
      await emit(tenantId, INCIDENT_OPENED, incident.id, { incidentId: incident.id, rule: b.rule, subjectCiId: b.subjectCiId, source: READINESS.incidentSource });
      report.opened += 1;
    }
    for (const [key, finding] of openKeys) {
      if (breachKeys.has(key)) continue;
      await prisma.readinessFinding.update({ where: { id: finding.id }, data: { state: 'cleared', clearedAt: new Date(at) } });
      if (finding.incidentId !== null) {
        await prisma.incident.updateMany({ where: { id: finding.incidentId, state: { in: ['open', 'acknowledged', 'mitigated'] } }, data: { state: 'resolved', resolvedAt: new Date(at), resolutionNote: 'Readiness restored: ' + finding.detail } });
        await emit(tenantId, INCIDENT_RESOLVED, finding.incidentId, { incidentId: finding.incidentId, rule: finding.rule, subjectCiId: finding.subjectCiId });
      }
      report.cleared += 1;
    }
    return report;
  }

  return { evaluateTenant };
}
