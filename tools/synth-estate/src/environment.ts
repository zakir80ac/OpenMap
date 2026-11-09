// REQ-DCIM-006 REQ-QA-001 — a deterministic environmental history for an emitted estate, through the real collector
// contract: every few hours over the last days, each rack's inlet and outlet temperature (label `position`), each room's
// humidity and each cooling unit's supply and return air, humidity and capacity in use, under the metric names the
// SNMP collector uses. Each CI has its own profile seeded by its identity: most racks breathe inside the recommended
// range, a few run warm, and a few have starved airflow (a large rise across the rack), as in a real hall.
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { ENV_METRICS, type CollectorResult, type MetricSample, type ObservedCi } from '@openmap/contracts';
import { Rng } from './rng.js';

export const ENVIRONMENT_HISTORY_FILE = 'environment-history.ndjson';

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const PEAK_HOUR = 15;
const DAILY_SWING_C = 1.2;
const NOISE_C = 0.4;
const NOISE_RH = 1.5;
const TENTHS = 10;
/** Shares of racks that run warm and that have starved airflow. */
const WARM_SHARE = 0.08;
const HOT_SHARE = 0.01;
const STARVED_SHARE = 0.05;
const INLET_C = [20, 25] as const;
const WARM_INLET_C = [27.5, 30] as const;
const HOT_INLET_C = [32.5, 34] as const;
const RISE_C = [8, 16] as const;
const STARVED_RISE_C = [21, 24] as const;
const ROOM_RH = [35, 55] as const;
const HUMID_ROOM_SHARE = 0.15;
const HUMID_ROOM_RH = [61, 66] as const;
const SUPPLY_C = [15, 18] as const;
const RETURN_RISE_C = [9, 14] as const;
const CAPACITY_PERCENT = [40, 85] as const;
/** Capacity in use follows the day's load by this many points either side. */
const CAPACITY_SWING = 5;

function between(r: Rng, range: readonly [number, number]): number {
  return range[0] + r.next() * (range[1] - range[0]);
}

function daily(ts: number): number {
  const hour = (ts / MS_PER_HOUR) % HOURS_PER_DAY;
  return Math.cos(((hour - PEAK_HOUR) / HOURS_PER_DAY) * 2 * Math.PI);
}

const tenth = (v: number): number => Math.round(v * TENTHS) / TENTHS;

interface Subject {
  source: CollectorResult;
  ci: ObservedCi;
}

function samplesFor(s: Subject, ts: number, noise: Rng): MetricSample[] {
  const ref = { type: s.ci.type, identity: s.ci.identity };
  const at = new Date(ts).toISOString();
  const r = new Rng('environment:' + s.ci.type + ':' + JSON.stringify(s.ci.identity));
  const wave = daily(ts);
  const jitter = (n: number): number => (noise.next() - 0.5) * 2 * n;
  const sample = (metric: string, value: number, unit: string, labels: Record<string, string>): MetricSample => ({ ci: ref, metric, ts: at, value: tenth(value), unit, labels });
  if (s.ci.type === 'rack') {
    const draw = r.next();
    const inlet = between(r, draw < HOT_SHARE ? HOT_INLET_C : draw < HOT_SHARE + WARM_SHARE ? WARM_INLET_C : INLET_C);
    const rise = between(r, r.next() < STARVED_SHARE ? STARVED_RISE_C : RISE_C);
    const now = inlet + DAILY_SWING_C * wave + jitter(NOISE_C);
    return [
      sample(ENV_METRICS.temperature, now, 'C', { position: 'inlet', sensor: 'rack-inlet' }),
      sample(ENV_METRICS.temperature, now + rise + jitter(NOISE_C), 'C', { position: 'outlet', sensor: 'rack-outlet' }),
    ];
  }
  if (s.ci.type === 'room') {
    const rh = between(r, r.next() < HUMID_ROOM_SHARE ? HUMID_ROOM_RH : ROOM_RH);
    return [sample(ENV_METRICS.humidity, rh + jitter(NOISE_RH), 'percent', { position: 'room', sensor: 'room' })];
  }
  const supply = between(r, SUPPLY_C);
  const rise = between(r, RETURN_RISE_C);
  const capacity = between(r, CAPACITY_PERCENT);
  return [
    sample(ENV_METRICS.temperature, supply + jitter(NOISE_C), 'C', { position: 'supply', sensor: 'supply-air' }),
    sample(ENV_METRICS.temperature, supply + rise + DAILY_SWING_C * wave + jitter(NOISE_C), 'C', { position: 'return', sensor: 'return-air' }),
    sample(ENV_METRICS.humidity, between(r, ROOM_RH) + jitter(NOISE_RH), 'percent', { position: 'return', sensor: 'return-humidity' }),
    sample(ENV_METRICS.coolingCapacity, capacity + CAPACITY_SWING * wave, 'percent', {}),
  ];
}

/** Sample-only results for the racks, rooms and cooling units in `results`, every `everyHours` over `days`. */
export function environmentHistory(results: readonly CollectorResult[], seed: number, now: string, days: number, everyHours: number): CollectorResult[] {
  const ids = new Rng(seed).fork('environment-history');
  const nowMs = Date.parse(now);
  const steps = Math.floor((days * HOURS_PER_DAY) / everyHours);
  const bySource = new Map<CollectorResult, ObservedCi[]>();
  for (const source of results) {
    const cis = source.cis.filter((c) => c.type === 'rack' || c.type === 'room' || c.type === 'cooling_unit');
    if (cis.length > 0) bySource.set(source, cis);
  }
  const out: CollectorResult[] = [];
  for (let step = steps; step >= 0; step--) {
    const ts = nowMs - step * everyHours * MS_PER_HOUR;
    const at = new Date(ts).toISOString();
    for (const [source, cis] of bySource) {
      const noise = new Rng(seed).fork('environment-noise:' + source.runId + ':' + String(step));
      const samples = cis.flatMap((ci) => samplesFor({ source, ci }, ts, noise));
      out.push({
        jobId: ids.uuid(),
        runId: ids.uuid(),
        tenantId: source.tenantId,
        collectorId: source.collectorId,
        nodeId: source.nodeId,
        status: 'success',
        startedAt: at,
        finishedAt: at,
        cis: [],
        relationships: [],
        samples,
        evidence: [],
        errors: [],
        metrics: { targetsAttempted: cis.length, targetsReached: cis.length, cisEmitted: 0, relationshipsEmitted: 0, durationMs: 0 },
        contractVersion: CONTRACT_VERSIONS.collector,
      });
    }
  }
  return out;
}
