// REQ-DCIM-005 REQ-QA-001 — a deterministic power history for an emitted estate, through the real collector contract:
// - every PDU's cords (the `powered_by` relationships from devices) are numbered onto its outlets, in device order, up
//   to the PDU's outlet count (cords past it get no outlet, as on an over-full PDU); each used outlet is emitted as
//   the `power_feed` CI the SNMP collector emits (identity pduRef + name, contained by the PDU), and the device is
//   `powered_by` that outlet;
// - every few hours over the last days, each outlet's draw and the PDU's total are emitted as samples under the metric
//   names the SNMP collector uses. A PDU's total follows the draw the estate reported for it (measuredKw), spread over
//   its outlets with each device's own profile and a business-hours swing.
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { POWER_METRICS, type CollectorResult, type MetricSample, type ObservedCi, type ObservedRelationship } from '@openmap/contracts';
import { Rng } from './rng.js';

export const POWER_HISTORY_FILE = 'power-history.ndjson';

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const WATTS_PER_KW = 1_000;
const UNIT = 'W';
/** A device's share of its PDU's draw varies by this factor either side of an even split. */
const SHARE_JITTER = 0.3;
/** Daily swing of a device's draw, as a share of its base, and the hour it peaks. */
const DAILY_SWING = 0.12;
const PEAK_HOUR = 14;
const NOISE = 0.04;
/** A PDU's own consumption on top of its outlets (metering, fans), as a share of the outlet total. */
const PDU_OVERHEAD = 0.02;

const key = (identity: Record<string, string>): string => JSON.stringify(Object.entries(identity).sort());

function daily(ts: number): number {
  const hour = (ts / MS_PER_HOUR) % HOURS_PER_DAY;
  return Math.cos(((hour - PEAK_HOUR) / HOURS_PER_DAY) * 2 * Math.PI);
}

interface PduPlan {
  source: CollectorResult;
  pdu: ObservedCi;
  outlets: Array<{ feed: ObservedCi; base: number }>;
  cords: ObservedRelationship[];
}

function plan(results: readonly CollectorResult[]): PduPlan[] {
  const cordsByPdu = new Map<string, ObservedRelationship[]>();
  for (const r of results)
    for (const rel of r.relationships)
      if (rel.type === 'powered_by' && 'type' in rel.to && rel.to.type === 'pdu' && 'type' in rel.from && rel.from.type !== 'power_circuit') {
        const k = key(rel.to.identity);
        cordsByPdu.set(k, [...(cordsByPdu.get(k) ?? []), rel]);
      }
  const plans: PduPlan[] = [];
  for (const source of results)
    for (const pdu of source.cis.filter((c) => c.type === 'pdu')) {
      const serial = pdu.identity['serialNumber'];
      if (serial === undefined) continue;
      const cords = [...(cordsByPdu.get(key(pdu.identity)) ?? [])].sort((a, b) => key('identity' in a.from ? a.from.identity : {}).localeCompare(key('identity' in b.from ? b.from.identity : {})));
      const outletCount = typeof pdu.attributes['outlets'] === 'number' ? pdu.attributes['outlets'] : cords.length;
      const used = cords.slice(0, outletCount);
      const totalWatts = (typeof pdu.attributes['measuredKw'] === 'number' ? pdu.attributes['measuredKw'] : 0) * WATTS_PER_KW;
      const r = new Rng('power:' + serial);
      const weights = used.map(() => 1 + (r.next() - 0.5) * 2 * SHARE_JITTER);
      const sum = weights.reduce((a, b) => a + b, 0) || 1;
      plans.push({
        source,
        pdu,
        cords,
        outlets: used.map((_, i) => ({
          feed: {
            type: 'power_feed',
            identity: { pduRef: serial, name: 'outlet-' + String(i + 1) },
            name: String(pdu.name) + ' outlet ' + String(i + 1),
            attributes: { outletIndex: String(i + 1), pdu: serial },
            tags: ['power'],
            externalIds: [],
            observedAt: pdu.observedAt,
          },
          base: (totalWatts * (weights[i] ?? 1)) / sum / (1 + PDU_OVERHEAD),
        })),
      });
    }
  return plans;
}

function result(ids: Rng, source: CollectorResult, at: string, parts: Pick<CollectorResult, 'cis' | 'relationships' | 'samples'>): CollectorResult {
  return {
    jobId: ids.uuid(),
    runId: ids.uuid(),
    tenantId: source.tenantId,
    collectorId: source.collectorId,
    nodeId: source.nodeId,
    status: 'success',
    startedAt: at,
    finishedAt: at,
    ...parts,
    evidence: [],
    errors: [],
    metrics: { targetsAttempted: 1, targetsReached: 1, cisEmitted: parts.cis.length, relationshipsEmitted: parts.relationships.length, durationMs: 0 },
    contractVersion: CONTRACT_VERSIONS.collector,
  };
}

/**
 * One structural result per PDU source (the outlets as power_feed CIs, contained by their PDU, and the cords re-observed
 * with their outlet number), then sample-only results every `everyHours` over the `days` before `now`.
 */
export function powerHistory(results: readonly CollectorResult[], seed: number, now: string, days: number, everyHours: number, withSamples = true): CollectorResult[] {
  const ids = new Rng(seed).fork('power-history');
  const nowMs = Date.parse(now);
  const steps = Math.floor((days * HOURS_PER_DAY) / everyHours);
  const firstAt = new Date(nowMs - steps * everyHours * MS_PER_HOUR).toISOString();
  const plans = plan(results);
  const out: CollectorResult[] = [];
  for (const p of plans) {
    const pduRef = { type: p.pdu.type, identity: p.pdu.identity };
    const relationships: ObservedRelationship[] = [
      ...p.outlets.map((o) => ({ type: 'contains' as const, from: pduRef, to: { type: o.feed.type, identity: o.feed.identity }, attributes: {}, observedAt: firstAt })),
      // The device is powered by the outlet its cord is plugged into (the PDU's own powered_by stays as observed).
      ...p.cords.slice(0, p.outlets.length).map((c, i) => ({ type: 'powered_by' as const, from: c.from, to: { type: 'power_feed' as const, identity: p.outlets[i]?.feed.identity ?? {} }, attributes: { ...c.attributes, outlet: i + 1 }, observedAt: firstAt })),
    ];
    out.push(result(ids, p.source, firstAt, { cis: p.outlets.map((o) => ({ ...o.feed, observedAt: firstAt })), relationships, samples: [] }));
  }
  for (let step = withSamples ? steps : -1; step >= 0; step--) {
    const ts = nowMs - step * everyHours * MS_PER_HOUR;
    const at = new Date(ts).toISOString();
    const wave = daily(ts);
    for (const p of plans) {
      if (p.outlets.length === 0) continue;
      const noise = new Rng('power-noise:' + String(p.pdu.identity['serialNumber']) + ':' + String(step));
      const serial = String(p.pdu.identity['serialNumber']);
      const samples: MetricSample[] = p.outlets.map((o, i) => ({
        ci: { type: o.feed.type, identity: o.feed.identity },
        metric: POWER_METRICS.outlet,
        ts: at,
        value: Math.max(0, Math.round(o.base * (1 + DAILY_SWING * wave + (noise.next() - 0.5) * 2 * NOISE))),
        unit: UNIT,
        labels: { pdu: serial, outlet: String(i + 1) },
      }));
      const total = Math.round(samples.reduce((sum, s) => sum + s.value, 0) * (1 + PDU_OVERHEAD));
      samples.push({ ci: { type: p.pdu.type, identity: p.pdu.identity }, metric: POWER_METRICS.pdu, ts: at, value: total, unit: UNIT, labels: { pdu: serial, feed: String(p.pdu.attributes['feed'] ?? ''), rack: String(p.pdu.attributes['rack'] ?? '') } });
      out.push(result(ids, p.source, at, { cis: [], relationships: [], samples }));
    }
  }
  return out;
}
