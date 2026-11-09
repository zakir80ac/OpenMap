// REQ-DCIM-005 (ADR-059) — power threshold alerting for one tenant: every PDU's latest draw (ClickHouse metrics_latest)
// against its rating and the tenant's critical line (power_settings, or the DCIM default). A PDU over the line opens one
// incident (source `power`, the PDU as root cause); when its draw falls back under the line the incident is resolved.
// A reading older than POWER.alertFreshMs is not judged, so a PDU that stopped being read neither opens nor resolves.
import { DCIM, POWER } from '@openmap/constants';
import { POWER_METRICS, pduRatedWatts, powerState, type EventType } from '@openmap/contracts';
import type { PrismaClient } from '@openmap/db';
import { envelope, INCIDENT_OPENED, INCIDENT_RESOLVED } from './engine.js';
import type { ClickHouseQuery } from './readiness.js';

export interface PowerAlertDeps {
  prisma: PrismaClient;
  query: ClickHouseQuery;
  database: string;
  now: () => string;
}

export interface PowerAlertReport {
  pdus: number;
  judged: number;
  opened: number;
  resolved: number;
}

interface LatestRow {
  pdu_ci: string;
  v: number;
  ms: string | number;
}

const OPEN_STATES = ['open', 'acknowledged', 'mitigated'] as const;

export function createPowerAlerts(deps: PowerAlertDeps) {
  const { prisma } = deps;

  async function evaluateTenant(tenantId: string): Promise<PowerAlertReport> {
    const report: PowerAlertReport = { pdus: 0, judged: 0, opened: 0, resolved: 0 };
    const pdus = await prisma.ci.findMany({ where: { tenantId, type: 'pdu', validTo: null }, select: { id: true, name: true, attributes: true } });
    report.pdus = pdus.length;
    if (pdus.length === 0) return report;
    const settingsRow = await prisma.powerSettings.findUnique({ where: { tenantId } });
    const lines = { warnPercent: settingsRow?.warnPercent ?? DCIM.warnPowerPercent, criticalPercent: settingsRow?.criticalPercent ?? DCIM.criticalPowerPercent };
    const latest = new Map<string, { watts: number; at: number }>();
    for (let i = 0; i < pdus.length; i += POWER.monitorIdBatch) {
      const rows = (await deps.query(
        'power_latest',
        'SELECT toString(ci_id) AS pdu_ci, argMax(value, ts) AS v, toUnixTimestamp64Milli(max(ts)) AS ms FROM ' +
          deps.database +
          '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND metric = {metric:String} AND ci_id IN ({ids:Array(UUID)}) GROUP BY ci_id',
        { tenantId, metric: POWER_METRICS.pdu, ids: pdus.slice(i, i + POWER.monitorIdBatch).map((p) => p.id) },
      )) as LatestRow[];
      for (const r of rows) latest.set(r.pdu_ci, { watts: r.v, at: Number(r.ms) });
    }
    const nowMs = Date.parse(deps.now());
    const open = await prisma.incident.findMany({ where: { tenantId, source: POWER.incidentSource, state: { in: [...OPEN_STATES] } }, select: { id: true, rootCauseCiId: true } });
    const openFor = new Map(open.map((i) => [i.rootCauseCiId ?? '', i.id]));
    const at = new Date(deps.now());
    for (const pdu of pdus) {
      const reading = latest.get(pdu.id);
      if (reading === undefined || nowMs - reading.at > POWER.alertFreshMs) continue;
      report.judged += 1;
      const attributes = pdu.attributes !== null && typeof pdu.attributes === 'object' ? (pdu.attributes as Record<string, unknown>) : {};
      const rated = pduRatedWatts(attributes);
      const critical = powerState(reading.watts, rated, lines) === 'critical';
      const incidentId = openFor.get(pdu.id);
      if (critical && incidentId === undefined) {
        const detail = pdu.name + ' draws ' + String(Math.round(reading.watts)) + ' W of its ' + String(rated) + ' W rating (critical line ' + String(lines.criticalPercent) + '%)';
        const incident = await prisma.incident.create({
          data: {
            tenantId,
            title: 'Power: ' + detail,
            description: detail,
            severity: POWER.incidentSeverity,
            state: 'open',
            source: POWER.incidentSource,
            affectedServiceCiIds: [],
            rootCauseCiId: pdu.id,
            correlatedEventIds: [],
            openedAt: at,
          },
        });
        await emit(tenantId, INCIDENT_OPENED, incident.id, { incidentId: incident.id, subjectCiId: pdu.id, source: POWER.incidentSource, watts: reading.watts, ratedWatts: rated });
        report.opened += 1;
      } else if (!critical && incidentId !== undefined) {
        await prisma.incident.updateMany({ where: { id: incidentId, state: { in: [...OPEN_STATES] } }, data: { state: 'resolved', resolvedAt: at, resolutionNote: pdu.name + ' is back under the critical line' } });
        await emit(tenantId, INCIDENT_RESOLVED, incidentId, { incidentId, subjectCiId: pdu.id, source: POWER.incidentSource });
        report.resolved += 1;
      }
    }
    return report;
  }

  async function emit(tenantId: string, type: EventType, subject: string, data: Record<string, unknown>): Promise<void> {
    const e = envelope(tenantId, type, subject, data, deps.now());
    await prisma.outboxEvent.create({ data: { eventId: e.id, tenantId, type: e.type, subject: e.subject, envelope: e as never, pending: ['clickhouse', 'websocket'] } });
  }

  return { evaluateTenant };
}
