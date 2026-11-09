// REQ-DCIM-006 (ADR-060) — environmental alerting for one tenant: each rack's newest inlet temperature (its own sensor,
// or a probe on a PDU located in it) within ENVIRONMENT.freshMs, against the ASHRAE A1 allowable range. A rack outside it
// opens one incident (source `environment`, the rack as root cause); back inside the range, the incident is resolved.
// metrics_latest keeps no labels, so the inlet readings are read from metrics over the freshness window.
import { ENVIRONMENT, POWER } from '@openmap/constants';
import { ENV_METRICS, temperatureState, type EventType } from '@openmap/contracts';
import type { PrismaClient } from '@openmap/db';
import { envelope, INCIDENT_OPENED, INCIDENT_RESOLVED } from './engine.js';
import type { ClickHouseQuery } from './readiness.js';

export interface EnvironmentAlertDeps {
  prisma: PrismaClient;
  query: ClickHouseQuery;
  database: string;
  now: () => string;
}

export interface EnvironmentAlertReport {
  racks: number;
  judged: number;
  opened: number;
  resolved: number;
}

interface InletRow {
  env_ci: string;
  v: number;
}

const OPEN_STATES = ['open', 'acknowledged', 'mitigated'] as const;

export function createEnvironmentAlerts(deps: EnvironmentAlertDeps) {
  const { prisma } = deps;

  async function emit(tenantId: string, type: EventType, subject: string, data: Record<string, unknown>): Promise<void> {
    const e = envelope(tenantId, type, subject, data, deps.now());
    await prisma.outboxEvent.create({ data: { eventId: e.id, tenantId, type: e.type, subject: e.subject, envelope: e as never, pending: ['clickhouse', 'websocket'] } });
  }

  async function evaluateTenant(tenantId: string): Promise<EnvironmentAlertReport> {
    const report: EnvironmentAlertReport = { racks: 0, judged: 0, opened: 0, resolved: 0 };
    const racks = await prisma.ci.findMany({ where: { tenantId, type: 'rack', validTo: null }, select: { id: true, name: true } });
    report.racks = racks.length;
    if (racks.length === 0) return report;
    const probes = await prisma.relationship.findMany({ where: { tenantId, type: 'located_in', validTo: null, toCiId: { in: racks.map((r) => r.id) }, fromCi: { type: 'pdu', validTo: null } }, select: { fromCiId: true, toCiId: true } });
    const rackOf = new Map<string, string>([...racks.map((r): [string, string] => [r.id, r.id]), ...probes.map((p): [string, string] => [p.fromCiId, p.toCiId])]);
    const since = new Date(Date.parse(deps.now()) - ENVIRONMENT.freshMs).toISOString().replace('T', ' ').replace('Z', '');
    const inlet = new Map<string, number>();
    const ids = [...rackOf.keys()];
    for (let i = 0; i < ids.length; i += POWER.monitorIdBatch) {
      const rows = (await deps.query(
        'environment_inlets',
        "SELECT toString(ci_id) AS env_ci, argMax(value, ts) AS v FROM " +
          deps.database +
          ".metrics WHERE tenant_id = {tenantId:UUID} AND metric = {metric:String} AND labels['position'] = 'inlet' AND ci_id IN ({ids:Array(UUID)}) AND ts >= toDateTime64({since:String}, 3) GROUP BY ci_id",
        { tenantId, metric: ENV_METRICS.temperature, ids: ids.slice(i, i + POWER.monitorIdBatch), since },
      )) as InletRow[];
      for (const r of rows) {
        const rack = rackOf.get(r.env_ci);
        if (rack !== undefined) inlet.set(rack, Math.max(inlet.get(rack) ?? r.v, r.v));
      }
    }
    const open = await prisma.incident.findMany({ where: { tenantId, source: ENVIRONMENT.incidentSource, state: { in: [...OPEN_STATES] } }, select: { id: true, rootCauseCiId: true } });
    const openFor = new Map(open.map((i) => [i.rootCauseCiId ?? '', i.id]));
    const at = new Date(deps.now());
    for (const rack of racks) {
      const c = inlet.get(rack.id);
      if (c === undefined) continue;
      report.judged += 1;
      const critical = temperatureState(c) === 'critical';
      const incidentId = openFor.get(rack.id);
      if (critical && incidentId === undefined) {
        const detail = rack.name + ' inlet reads ' + c.toFixed(1) + ' °C, outside the allowable ' + String(ENVIRONMENT.allowableC.min) + '–' + String(ENVIRONMENT.allowableC.max) + ' °C';
        const incident = await prisma.incident.create({
          data: { tenantId, title: 'Environment: ' + detail, description: detail, severity: ENVIRONMENT.incidentSeverity, state: 'open', source: ENVIRONMENT.incidentSource, affectedServiceCiIds: [], rootCauseCiId: rack.id, correlatedEventIds: [], openedAt: at },
        });
        await emit(tenantId, INCIDENT_OPENED, incident.id, { incidentId: incident.id, subjectCiId: rack.id, source: ENVIRONMENT.incidentSource, inletC: c });
        report.opened += 1;
      } else if (!critical && incidentId !== undefined) {
        await prisma.incident.updateMany({ where: { id: incidentId, state: { in: [...OPEN_STATES] } }, data: { state: 'resolved', resolvedAt: at, resolutionNote: rack.name + ' inlet is back inside the allowable range' } });
        await emit(tenantId, INCIDENT_RESOLVED, incidentId, { incidentId, subjectCiId: rack.id, source: ENVIRONMENT.incidentSource });
        report.resolved += 1;
      }
    }
    return report;
  }

  return { evaluateTenant };
}
