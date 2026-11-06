// REQ-CMDB-034 REQ-QA-001 — a deterministic utilisation history for an emitted estate: for every server and VM the
// estate's collectors observed, CPU, memory and fullest-disk shares (and a server's power draw) sampled every few
// hours over the last days, written as sample-only collector results (one per source result and instant) that replay
// through the real pipeline into ClickHouse. Each CI has its own profile (base load, daily swing, growth) seeded by its
// identity, so a small share runs hot and a share sits idle, as in a real estate.
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { UTILISATION_METRICS, type CollectorResult, type MetricSample, type ObservedCi } from '@openmap/contracts';
import { Rng } from './rng.js';

export const UTILISATION_HISTORY_FILE = 'utilisation-history.ndjson';

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const PERCENT_MAX = 100;
const PERCENT_FLOOR = 0.5;
/** Share of CIs that run hot (CPU or memory near capacity) and that sit idle. */
const HOT_SHARE = 0.06;
const IDLE_SHARE = 0.12;
const HOT_BASE = [78, 92] as const;
const IDLE_BASE = [1, 7] as const;
const NORMAL_BASE = [15, 65] as const;
const DAILY_SWING = [2, 14] as const;
const NOISE = 3;
const DISK_BASE = [20, 90] as const;
/** Disk grows by up to this many points over the whole window. */
const DISK_GROWTH = 6;
const POWER_WATTS = [280, 720] as const;
const POWER_PER_CPU_POINT = 2.4;
/** Hour of the day load peaks (business hours). */
const PEAK_HOUR = 14;

interface Profile {
  cpu: number;
  memory: number;
  swing: number;
  disk: number;
  watts: number;
}

function between(r: Rng, range: readonly [number, number]): number {
  return range[0] + r.next() * (range[1] - range[0]);
}

function profileOf(key: string): Profile {
  const r = new Rng('utilisation:' + key);
  const draw = r.next();
  const base = draw < HOT_SHARE ? HOT_BASE : draw < HOT_SHARE + IDLE_SHARE ? IDLE_BASE : NORMAL_BASE;
  return { cpu: between(r, base), memory: between(r, base), swing: between(r, DAILY_SWING), disk: between(r, DISK_BASE), watts: between(r, POWER_WATTS) };
}

function clampPercent(v: number): number {
  return Math.round(Math.min(PERCENT_MAX, Math.max(PERCENT_FLOOR, v)) * PERCENT_MAX) / PERCENT_MAX;
}

/** Diurnal factor in [-1, 1], highest at PEAK_HOUR. */
function daily(ts: number): number {
  const hour = (ts / MS_PER_HOUR) % HOURS_PER_DAY;
  return Math.cos(((hour - PEAK_HOUR) / HOURS_PER_DAY) * 2 * Math.PI);
}

function samplesFor(ci: ObservedCi, ts: number, progress: number, noise: Rng): MetricSample[] {
  const metrics = UTILISATION_METRICS[ci.type];
  if (metrics === undefined) return [];
  const p = profileOf(ci.type + '|' + JSON.stringify(ci.identity));
  const ref = { type: ci.type, identity: ci.identity };
  const at = new Date(ts).toISOString();
  const wave = daily(ts);
  const out: MetricSample[] = [];
  const cpu = clampPercent(p.cpu + p.swing * wave + (noise.next() - 0.5) * 2 * NOISE);
  if (metrics.cpu) out.push({ ci: ref, metric: metrics.cpu.metric, ts: at, value: cpu, unit: metrics.cpu.unit, labels: {} });
  if (metrics.memory)
    out.push({ ci: ref, metric: metrics.memory.metric, ts: at, value: clampPercent(p.memory + (p.swing / 2) * wave + (noise.next() - 0.5) * NOISE), unit: metrics.memory.unit, labels: {} });
  if (metrics.disk) out.push({ ci: ref, metric: metrics.disk.metric, ts: at, value: clampPercent(p.disk + DISK_GROWTH * progress), unit: metrics.disk.unit, labels: { mount: '/' } });
  if (metrics.power) out.push({ ci: ref, metric: metrics.power.metric, ts: at, value: Math.round(p.watts + cpu * POWER_PER_CPU_POINT), unit: metrics.power.unit, labels: {} });
  return out;
}

/**
 * Sample-only results for the hosts and VMs in `results`, every `everyHours` over the `days` before `now`. One result
 * per source result and instant, carrying that result's collector, node and tenant.
 */
export function utilisationHistory(results: readonly CollectorResult[], seed: number, now: string, days: number, everyHours: number): CollectorResult[] {
  const ids = new Rng(seed).fork('utilisation-history');
  const nowMs = Date.parse(now);
  const steps = Math.floor((days * HOURS_PER_DAY) / everyHours);
  const out: CollectorResult[] = [];
  for (const source of results) {
    const cis = source.cis.filter((c) => c.type === 'host' || c.type === 'vm');
    if (cis.length === 0) continue;
    const noise = new Rng(seed).fork('utilisation-noise:' + source.runId);
    for (let step = steps; step >= 0; step--) {
      const ts = nowMs - step * everyHours * MS_PER_HOUR;
      const at = new Date(ts).toISOString();
      const samples = cis.flatMap((ci) => samplesFor(ci, ts, (steps - step) / Math.max(steps, 1), noise));
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
