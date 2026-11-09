// REQ-CMDB-034 — resource utilisation over the samples collectors write to ClickHouse: the estate register (each CI's
// latest CPU, memory, fullest-disk share and power draw from `metrics_latest`, hot or idle under UTILISATION's
// thresholds, sorted and paged) and one CI's history over a window, bucketed for a chart with its average and peak.
import { Injectable } from '@nestjs/common';
import { TIME, UTILISATION } from '@openmap/constants';
import {
  UTILISATION_CI_TYPES,
  UTILISATION_MEASURES,
  UTILISATION_METRIC_NAMES,
  UTILISATION_METRICS,
  measureOfMetric,
  utilisationState,
  type CiType,
  type UtilisationMeasure,
  type UtilisationState,
} from '@openmap/contracts';
import { ClickHouseService, clickhouseTime } from '../db/clickhouse.service.js';
import { PrismaService } from '../db/prisma.service.js';

export type UtilisationSort = UtilisationMeasure | 'name';

export interface UtilisationFilter {
  types: string[] | null;
  state: UtilisationState | null;
  text: string | null;
}

export interface UtilisationRowView {
  ciId: string;
  name: string;
  state: UtilisationState;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  power: number | null;
  observedAt: Date | null;
}

export interface UtilisationPageView {
  items: UtilisationRowView[];
  total: number;
  hot: number;
  idle: number;
  averageCpu: number | null;
  averageMemory: number | null;
  powerWatts: number | null;
}

export interface UtilisationPointView {
  at: Date;
  value: number;
  peak: number;
}

export interface UtilisationSeriesView {
  measure: UtilisationMeasure;
  metric: string;
  unit: string;
  latest: number | null;
  latestAt: Date | null;
  average: number | null;
  peak: number | null;
  points: UtilisationPointView[];
}

export interface CiUtilisationView {
  state: UtilisationState;
  hours: number;
  series: UtilisationSeriesView[];
}

interface LatestRow {
  ci_id: string;
  metric: string;
  value: number;
  /** Int64 columns arrive as strings in JSONEachRow. */
  ts_ms: string | number;
}

interface PointRow {
  metric: string;
  bucket_ms: string | number;
  avg: number;
  max: number;
}

const THRESHOLDS = { hotPercent: UTILISATION.hotPercent, idlePercent: UTILISATION.idlePercent };

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

@Injectable()
export class UtilisationService {
  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly prisma: PrismaService,
  ) {}

  /** Latest value per CI and measure, with the newest sample instant per CI. */
  private async latest(tenantId: string): Promise<Map<string, { values: Partial<Record<UtilisationMeasure, number>>; at: number }>> {
    const rows = await this.clickhouse.query<LatestRow>(
      'utilisation_latest',
      'SELECT ci_id, metric, argMax(value, ts) AS value, toUnixTimestamp64Milli(max(ts)) AS ts_ms FROM ' +
        this.clickhouse.database +
        '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND metric IN ({metrics:Array(String)}) GROUP BY ci_id, metric',
      { tenantId, metrics: [...UTILISATION_METRIC_NAMES] },
    );
    const out = new Map<string, { values: Partial<Record<UtilisationMeasure, number>>; at: number }>();
    for (const row of rows) {
      const measure = measureOfMetric(row.metric);
      if (measure === null) continue;
      const entry = out.get(row.ci_id) ?? { values: {}, at: 0 };
      entry.values[measure] = row.value;
      entry.at = Math.max(entry.at, Number(row.ts_ms));
      out.set(row.ci_id, entry);
    }
    return out;
  }

  async register(tenantId: string, filter: UtilisationFilter, sort: UtilisationSort, first: number, offset: number): Promise<UtilisationPageView> {
    const latest = await this.latest(tenantId);
    const text = filter.text?.trim() ?? '';
    const types = filter.types?.length ? filter.types : UTILISATION_CI_TYPES;
    const cis = await this.prisma.client.ci.findMany({
      where: {
        tenantId,
        id: { in: [...latest.keys()] },
        type: { in: types as CiType[] },
        validTo: null,
        ...(text === '' ? {} : { OR: [{ name: { contains: text, mode: 'insensitive' } }, { displayName: { contains: text, mode: 'insensitive' } }] }),
      },
      select: { id: true, displayName: true },
    });
    let rows: UtilisationRowView[] = cis.map((ci) => {
      const entry = latest.get(ci.id);
      const v = entry?.values ?? {};
      return {
        ciId: ci.id,
        name: ci.displayName,
        state: utilisationState(v, THRESHOLDS),
        cpu: v.cpu ?? null,
        memory: v.memory ?? null,
        disk: v.disk ?? null,
        power: v.power ?? null,
        observedAt: entry === undefined || entry.at === 0 ? null : new Date(entry.at),
      };
    });
    if (filter.state !== null) rows = rows.filter((r) => r.state === filter.state);
    rows.sort((a, b) => {
      if (sort !== 'name') {
        const x = a[sort];
        const y = b[sort];
        if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
      }
      return a.name.localeCompare(b.name);
    });
    const known = (key: 'cpu' | 'memory' | 'power'): number[] => rows.map((r) => r[key]).filter((v): v is number => v !== null);
    const take = Math.min(Math.max(first, 0), UTILISATION.maxPageSize);
    const watts = known('power');
    return {
      items: rows.slice(Math.max(offset, 0), Math.max(offset, 0) + take),
      total: rows.length,
      hot: rows.filter((r) => r.state === 'hot').length,
      idle: rows.filter((r) => r.state === 'idle').length,
      averageCpu: mean(known('cpu')),
      averageMemory: mean(known('memory')),
      powerWatts: watts.length === 0 ? null : watts.reduce((a, b) => a + b, 0),
    };
  }

  async ofCi(tenantId: string, ciId: string, type: string, hours: number, now: Date = new Date()): Promise<CiUtilisationView | null> {
    const metrics = UTILISATION_METRICS[type as CiType];
    if (metrics === undefined) return null;
    const from = new Date(now.getTime() - hours * TIME.msPerHour);
    const bucketSeconds = Math.max(1, Math.ceil((hours * TIME.msPerHour) / TIME.msPerSecond / UTILISATION.seriesPoints));
    const names = UTILISATION_MEASURES.flatMap((m) => (metrics[m] === undefined ? [] : [metrics[m].metric]));
    const [points, latest] = await Promise.all([
      this.clickhouse.query<PointRow>(
        'utilisation_series',
        'SELECT metric, toUnixTimestamp64Milli(toDateTime64(toStartOfInterval(ts, INTERVAL {bucket:UInt32} second), 3)) AS bucket_ms, avg(value) AS avg, max(value) AS max FROM ' +
          this.clickhouse.database +
          '.metrics WHERE tenant_id = {tenantId:UUID} AND ci_id = {ciId:UUID} AND metric IN ({metrics:Array(String)}) AND ts >= toDateTime64({from:String}, 3) AND ts <= toDateTime64({to:String}, 3)' +
          ' GROUP BY metric, bucket_ms ORDER BY metric, bucket_ms',
        { tenantId, ciId, metrics: names, bucket: bucketSeconds, from: clickhouseTime(from), to: clickhouseTime(now) },
      ),
      this.clickhouse.query<LatestRow>(
        'utilisation_ci_latest',
        'SELECT ci_id, metric, argMax(value, ts) AS value, toUnixTimestamp64Milli(max(ts)) AS ts_ms FROM ' +
          this.clickhouse.database +
          '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND ci_id = {ciId:UUID} AND metric IN ({metrics:Array(String)}) GROUP BY ci_id, metric',
        { tenantId, ciId, metrics: names },
      ),
    ]);
    const latestBy = new Map(latest.map((r) => [r.metric, r]));
    const series: UtilisationSeriesView[] = [];
    const measured: Partial<Record<UtilisationMeasure, number>> = {};
    for (const measure of UTILISATION_MEASURES) {
      const spec = metrics[measure];
      if (spec === undefined) continue;
      const own = points.filter((p) => p.metric === spec.metric).map((p) => ({ at: new Date(Number(p.bucket_ms)), value: p.avg, peak: p.max }));
      const last = latestBy.get(spec.metric);
      if (last !== undefined) measured[measure] = last.value;
      series.push({
        measure,
        metric: spec.metric,
        unit: spec.unit,
        latest: last?.value ?? null,
        latestAt: last === undefined ? null : new Date(Number(last.ts_ms)),
        average: mean(own.map((p) => p.value)),
        peak: own.length === 0 ? null : Math.max(...own.map((p) => p.peak)),
        points: own,
      });
    }
    return { state: utilisationState(measured, THRESHOLDS), hours, series };
  }
}
