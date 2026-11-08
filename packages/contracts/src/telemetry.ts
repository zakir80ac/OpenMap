// REQ-UI-027 — the health and telemetry fleet: the measures its table shows and the ClickHouse metric each CI type
// reports them under. CPU and memory are the utilisation metrics (REQ-CMDB-034); IOPS, throughput and Apdex are the
// storage, database, network and application layers' headline metrics (ADR-016).
import { z } from 'zod';
import { LAYER_HEADLINE_METRIC } from './ci.js';
import { UTILISATION_METRICS } from './utilisation.js';

export const FLEET_MEASURES = ['cpu', 'memory', 'iops', 'throughput', 'apdex'] as const;
export const fleetMeasureSchema = z.enum(FLEET_MEASURES);
export type FleetMeasure = z.infer<typeof fleetMeasureSchema>;

/** The table's sort keys: a measure (highest first), the worst health first, or the name. */
export const FLEET_SORTS = [...FLEET_MEASURES, 'health', 'name'] as const;
export const fleetSortSchema = z.enum(FLEET_SORTS);
export type FleetSort = z.infer<typeof fleetSortSchema>;

const utilisationMetric = (measure: 'cpu' | 'memory'): string[] =>
  Object.values(UTILISATION_METRICS).flatMap((byMeasure) => {
    const m = byMeasure[measure];
    return m === undefined ? [] : [m.metric];
  });

/** The metric names behind each measure; a CI reports at most one of each. */
export const FLEET_METRICS: Readonly<Record<FleetMeasure, readonly string[]>> = {
  cpu: utilisationMetric('cpu'),
  memory: utilisationMetric('memory'),
  iops: [LAYER_HEADLINE_METRIC.storage.metric, LAYER_HEADLINE_METRIC.databases.metric],
  /** Gigabits per second. */
  throughput: [LAYER_HEADLINE_METRIC.network_security.metric],
  /** 0 to 1. */
  apdex: [LAYER_HEADLINE_METRIC.applications.metric],
};

/** Every fleet metric name, without repeats; the API asks ClickHouse for exactly these. */
export const FLEET_METRIC_NAMES: readonly string[] = [...new Set(Object.values(FLEET_METRICS).flat())];

/** The measure a metric name stands for, or null when the fleet does not show it. */
export function fleetMeasureOfMetric(metric: string): FleetMeasure | null {
  for (const measure of FLEET_MEASURES) if (FLEET_METRICS[measure].includes(metric)) return measure;
  return null;
}

/** CI attributes the table reads for the address and site columns; collectors and setup write them. */
export const FLEET_ATTRIBUTES = {
  site: 'site',
  fqdn: 'fqdn',
  ipAddress: 'ipAddress',
  managementIp: 'managementIp',
} as const;
