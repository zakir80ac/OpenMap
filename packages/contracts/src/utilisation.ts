// REQ-CMDB-034 — resource utilisation: the metric each CI type reports for CPU, memory, disk and power, as collectors
// sample them (collector result `samples`, ADR-016) into ClickHouse `metrics`. Percentages are 0–100 of capacity
// (disk is the fullest filesystem, labelled with its mount); power is watts drawn. The register and a CI's Utilisation
// tab read these names only, so a new collector joins by sampling the same names.
import type { CiType } from './ci.js';

export const UTILISATION_MEASURES = ['cpu', 'memory', 'disk', 'power'] as const;
export type UtilisationMeasure = (typeof UTILISATION_MEASURES)[number];

export interface UtilisationMetric {
  metric: string;
  /** `percent` for shares of capacity, `W` for power drawn. */
  unit: 'percent' | 'W';
}

const percent = (metric: string): UtilisationMetric => ({ metric, unit: 'percent' });
const watts = (metric: string): UtilisationMetric => ({ metric, unit: 'W' });

/** The metric behind each measure, per CI type that has one. */
export const UTILISATION_METRICS: Partial<Record<CiType, Partial<Record<UtilisationMeasure, UtilisationMetric>>>> = {
  host: {
    cpu: percent('host.cpu.utilisation_percent'),
    memory: percent('host.memory.utilisation_percent'),
    disk: percent('host.disk.utilisation_percent'),
    power: watts('host.power.watts'),
  },
  vm: {
    cpu: percent('vm.cpu.utilisation_percent'),
    memory: percent('vm.memory.utilisation_percent'),
    disk: percent('vm.disk.utilisation_percent'),
  },
  container: {
    cpu: percent('container.cpu.utilisation_percent'),
    memory: percent('container.memory.utilisation_percent'),
  },
  pdu: { power: watts('dcim.power.watts') },
};

/** CI types with at least one utilisation measure. */
export const UTILISATION_CI_TYPES = Object.keys(UTILISATION_METRICS) as CiType[];

/** Every utilisation metric name, without repeats; the API asks ClickHouse for exactly these. */
export const UTILISATION_METRIC_NAMES: readonly string[] = [
  ...new Set(Object.values(UTILISATION_METRICS).flatMap((m) => Object.values(m).map((x) => x.metric))),
];

/** The measure a metric name stands for, or null when it is not a utilisation metric. */
export function measureOfMetric(metric: string): UtilisationMeasure | null {
  for (const byMeasure of Object.values(UTILISATION_METRICS))
    for (const measure of UTILISATION_MEASURES) if (byMeasure[measure]?.metric === metric) return measure;
  return null;
}

export type UtilisationState = 'hot' | 'idle' | 'normal' | 'unknown';

export interface UtilisationThresholds {
  /** At or above this share of CPU or memory a CI is running hot (capacity at risk). */
  hotPercent: number;
  /** At or below this share of both CPU and memory a CI is idle (rightsizing or reclaim candidate). */
  idlePercent: number;
}

/**
 * Hot when CPU, memory or disk is at or above the hot threshold; idle when CPU and memory are both known and at or
 * below the idle threshold; unknown when neither CPU nor memory has been sampled.
 */
export function utilisationState(
  latest: Partial<Record<UtilisationMeasure, number>>,
  thresholds: UtilisationThresholds,
): UtilisationState {
  const { cpu, memory, disk } = latest;
  if ([cpu, memory, disk].some((v) => v !== undefined && v >= thresholds.hotPercent)) return 'hot';
  if (cpu === undefined && memory === undefined) return 'unknown';
  if (cpu !== undefined && memory !== undefined && cpu <= thresholds.idlePercent && memory <= thresholds.idlePercent) return 'idle';
  return 'normal';
}
