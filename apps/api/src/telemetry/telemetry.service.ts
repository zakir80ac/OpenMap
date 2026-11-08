// REQ-UI-027 — the health and telemetry fleet: every CI with a latest CPU, memory, IOPS, throughput or Apdex sample,
// with its category, site, address and health, filtered, sorted and paged for a virtualised table.
// - One snapshot per tenant joins the three stores: ClickHouse `metrics_latest` (the measurements), Postgres (the CIs
//   that reported them) and Memgraph (health as the BSM engine propagates it).
// - Every request is answered from the snapshot. A stale one keeps answering while a rebuild runs in the background,
//   so on a 100k-CI tenant a page costs a linear filter over rows already sorted for that sort key.
import { Injectable } from '@nestjs/common';
import { BSM, TELEMETRY, TIME } from '@openmap/constants';
import {
  FLEET_ATTRIBUTES,
  FLEET_SORTS,
  FLEET_METRIC_NAMES,
  fleetMeasureOfMetric,
  type CiLayer,
  type FleetMeasure,
  type FleetSort,
} from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import type { HealthState } from '../ci/ci.types.js';
import { ClickHouseService } from '../db/clickhouse.service.js';
import { GraphService } from '../db/graph.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';

export interface FleetRowView {
  ciId: string;
  name: string;
  layer: CiLayer;
  site: string | null;
  address: string | null;
  health: HealthState;
  cpu: number | null;
  memory: number | null;
  iops: number | null;
  throughput: number | null;
  apdex: number | null;
  observedAt: Date | null;
  /** Lower-case name, address and site, for the text filter. */
  search: string;
  /** Position by name; the numeric tie-break every other order uses (a collator compare per pair is too slow at 500k). */
  rank: number;
}

export interface FleetFilter {
  layers: readonly CiLayer[] | null;
  health: readonly HealthState[] | null;
  text: string | null;
}

export interface FleetPageView {
  items: FleetRowView[];
  total: number;
  healthy: number;
  degraded: number;
  down: number;
  unknown: number;
  asOf: Date;
}

export interface FleetSnapshot {
  rows: readonly FleetRowView[];
  builtAt: Date;
  /** Rows in each sort key's order, computed when the snapshot is built. */
  sorted: Map<FleetSort, readonly FleetRowView[]>;
  /**
   * Every row's search text in rank order, one per line, and where each starts: a text filter is one native indexOf
   * scan over this string instead of a substring test per row (100 ms against a few on 500k rows).
   */
  haystack: string;
  starts: Int32Array;
  /** Rows by category and health, for the pills and the total without a scan. */
  counts: Map<CiLayer, Record<HealthState, number>>;
  /** Each sort key's order split by category: a one-category page reads only its rows and stops when it is full. */
  sortedByLayer: Map<FleetSort, Map<CiLayer, readonly FleetRowView[]>>;
}

const LINE = String.fromCharCode(0x0a);

/** Ranks whose search text contains the needle, as a byte per rank. */
export function textMatches(snapshot: Pick<FleetSnapshot, 'haystack' | 'starts'>, needle: string): Uint8Array {
  const { haystack, starts } = snapshot;
  const marks = new Uint8Array(starts.length);
  if (needle === '' || needle.includes(LINE)) return marks;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    // The row holding `at`: the last start at or before it.
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= at) lo = mid;
      else hi = mid - 1;
    }
    marks[lo] = 1;
    at = haystack.indexOf(needle, starts[lo + 1] ?? haystack.length);
  }
  return marks;
}

const HEALTH_STATES = ['healthy', 'degraded', 'down', 'unknown'] as const satisfies readonly HealthState[];
/** Worst first: BSM.healthOrder runs best to worst. */
const HEALTH_RANK = new Map<HealthState, number>(BSM.healthOrder.map((h, i) => [h, BSM.healthOrder.length - i]));
const COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

const byRank = (a: FleetRowView, b: FleetRowView): number => a.rank - b.rank;

/** The comparator of a sort key over ranked rows: a measure highest first with no value last, health worst first, or the name. */
export function fleetComparator(sort: FleetSort): (a: FleetRowView, b: FleetRowView) => number {
  if (sort === 'name') return byRank;
  if (sort === 'health') return (a, b) => (HEALTH_RANK.get(a.health) ?? 0) - (HEALTH_RANK.get(b.health) ?? 0) || byRank(a, b);
  const key: FleetMeasure = sort;
  return (a, b) => {
    const x = a[key];
    const y = b[key];
    if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
    return byRank(a, b);
  };
}

/** Ranks rows by name, orders them for every sort key and counts them by category and health, so no request sorts. */
export function prepareSnapshot(rows: Array<Omit<FleetRowView, 'rank'>>, builtAt: Date): FleetSnapshot {
  const byName = [...rows].sort((a, b) => COLLATOR.compare(a.name, b.name) || (a.ciId < b.ciId ? -1 : 1));
  const ranked: FleetRowView[] = byName.map((r, rank) => ({ ...r, rank }));
  const sorted = new Map<FleetSort, readonly FleetRowView[]>([['name', ranked]]);
  for (const sort of FLEET_SORTS) if (sort !== 'name') sorted.set(sort, [...ranked].sort(fleetComparator(sort)));
  const starts = new Int32Array(ranked.length);
  const counts = new Map<CiLayer, Record<HealthState, number>>();
  let offset = 0;
  for (const [i, r] of ranked.entries()) {
    starts[i] = offset;
    offset += r.search.length + LINE.length;
    const c = counts.get(r.layer) ?? emptyCounts();
    c[r.health]++;
    counts.set(r.layer, c);
  }
  const sortedByLayer = new Map<FleetSort, Map<CiLayer, readonly FleetRowView[]>>();
  for (const [sort, ordered] of sorted) {
    const parts = new Map<CiLayer, FleetRowView[]>();
    for (const r of ordered) {
      const part = parts.get(r.layer);
      if (part === undefined) parts.set(r.layer, [r]);
      else part.push(r);
    }
    sortedByLayer.set(sort, parts);
  }
  return { rows: ranked, builtAt, sorted, haystack: ranked.map((r) => r.search.replaceAll(LINE, ' ')).join(LINE), starts, counts, sortedByLayer };
}

function emptyCounts(): Record<HealthState, number> {
  return { healthy: 0, degraded: 0, down: 0, unknown: 0 };
}

/**
 * One page of the fleet from a snapshot; pure, so the paging rules are tested without the stores. The health counts
 * and the total come from the snapshot's per-category counts, or from the text matches, so the ordered rows are only
 * walked until the page is full.
 */
export function pageFleet(snapshot: FleetSnapshot, filter: FleetFilter, sort: FleetSort, first: number, offset: number): FleetPageView {
  const layers = filter.layers !== null && filter.layers.length > 0 ? new Set(filter.layers) : null;
  const only = filter.layers?.length === 1 ? filter.layers[0] : undefined;
  const ordered =
    (only === undefined ? snapshot.sorted.get(sort) : (snapshot.sortedByLayer.get(sort)?.get(only) ?? [])) ??
    [...snapshot.rows].sort(fleetComparator(sort));
  const health = filter.health !== null && filter.health.length > 0 ? new Set(filter.health) : null;
  const text = filter.text?.trim().toLowerCase() ?? '';
  const matches = text === '' ? null : textMatches(snapshot, text);
  const counts = emptyCounts();
  if (matches === null) {
    for (const [layer, c] of snapshot.counts) {
      if (layers !== null && !layers.has(layer)) continue;
      for (const h of HEALTH_STATES) counts[h] += c[h];
    }
  } else {
    // `rows` is in rank order, so a match byte and its row share an index; only matched rows are read.
    for (let rank = 0; rank < matches.length; rank++) {
      if (matches[rank] !== 1) continue;
      const row = snapshot.rows[rank];
      if (row !== undefined && (layers === null || layers.has(row.layer))) counts[row.health]++;
    }
  }
  const total = HEALTH_STATES.reduce((n, h) => n + (health === null || health.has(h) ? counts[h] : 0), 0);
  const items: FleetRowView[] = [];
  const start = Math.max(offset, 0);
  const take = Math.min(Math.max(first, 0), TELEMETRY.maxPageSize);
  let seen = 0;
  for (const row of ordered) {
    if (items.length >= take || seen >= total) break;
    if (layers !== null && !layers.has(row.layer)) continue;
    if (matches !== null && matches[row.rank] !== 1) continue;
    if (health !== null && !health.has(row.health)) continue;
    if (seen >= start) items.push(row);
    seen++;
  }
  return { items, total, ...counts, asOf: snapshot.builtAt };
}

interface LatestRow {
  ci: string;
  metric: string;
  v: number;
  ms: string | number;
}

interface CiRow {
  id: string;
  name: string;
  layer: CiLayer;
  site: string | null;
  address: string | null;
}

interface Entry {
  snapshot: FleetSnapshot | null;
  building: Promise<FleetSnapshot> | null;
  usedAt: number;
}

@Injectable()
export class TelemetryService {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    private readonly metrics: MetricsService,
  ) {}

  async fleet(tenantId: string, filter: FleetFilter, sort: FleetSort, first: number, offset: number): Promise<FleetPageView> {
    return pageFleet(await this.snapshot(tenantId), filter, sort, first, offset);
  }

  /** The tenant's snapshot: built on first use, then refreshed in the background once older than TELEMETRY.snapshotMs. */
  async snapshot(tenantId: string, now: number = Date.now()): Promise<FleetSnapshot> {
    const entry = this.cache.get(tenantId) ?? { snapshot: null, building: null, usedAt: now };
    entry.usedAt = now;
    this.cache.set(tenantId, entry);
    this.evict();
    const stale = entry.snapshot === null || now - entry.snapshot.builtAt.getTime() >= TELEMETRY.snapshotMs;
    if (stale && entry.building === null) {
      entry.building = this.build(tenantId)
        .then((snapshot) => {
          entry.snapshot = snapshot;
          return snapshot;
        })
        .finally(() => {
          entry.building = null;
        });
      // A background refresh that fails leaves the old snapshot answering; the metric records the failure.
      if (entry.snapshot !== null) entry.building.catch(() => undefined);
    }
    if (entry.snapshot !== null) return entry.snapshot;
    if (entry.building === null) throw new Error('telemetry snapshot for ' + tenantId + ' is neither built nor building');
    return entry.building;
  }

  private evict(): void {
    if (this.cache.size <= TELEMETRY.snapshotTenants) return;
    const oldest = [...this.cache.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
    if (oldest !== undefined) this.cache.delete(oldest[0]);
  }

  private async build(tenantId: string): Promise<FleetSnapshot> {
    const started = Date.now();
    try {
      const snapshot = await withSpan(TRACER_NAME, 'telemetry.snapshot', { 'openmap.tenant': tenantId }, async () => {
        const latest = await this.latest(tenantId);
        const ids = [...latest.keys()];
        const [cis, health] = await Promise.all([this.cis(tenantId, ids), this.health(tenantId)]);
        const rows = cis.map((ci) => {
          const m = latest.get(ci.id) ?? { values: {}, at: 0 };
          return {
            ciId: ci.id,
            name: ci.name,
            layer: ci.layer,
            site: ci.site,
            address: ci.address,
            health: health.get(ci.id) ?? 'unknown',
            cpu: m.values.cpu ?? null,
            memory: m.values.memory ?? null,
            iops: m.values.iops ?? null,
            throughput: m.values.throughput ?? null,
            apdex: m.values.apdex ?? null,
            observedAt: m.at === 0 ? null : new Date(m.at),
            search: [ci.name, ci.address ?? '', ci.site ?? ''].join(' ').toLowerCase(),
          };
        });
        return prepareSnapshot(rows, new Date());
      });
      this.metrics.telemetrySnapshot.observe({ outcome: 'ok' }, (Date.now() - started) / TIME.msPerSecond);
      return snapshot;
    } catch (err) {
      this.metrics.telemetrySnapshot.observe({ outcome: 'error' }, (Date.now() - started) / TIME.msPerSecond);
      throw err;
    }
  }

  /** Latest value per CI and measure, and the newest sample instant per CI. */
  private async latest(tenantId: string): Promise<Map<string, { values: Partial<Record<FleetMeasure, number>>; at: number }>> {
    // `ci`, not `ci_id`: ClickHouse applies SELECT aliases in WHERE, so a string alias would break the UUID filter.
    const rows = await this.clickhouse.query<LatestRow>(
      'telemetry_fleet_latest',
      'SELECT toString(ci_id) AS ci, metric, argMax(value, ts) AS v, toUnixTimestamp64Milli(max(ts)) AS ms FROM ' +
        this.clickhouse.database +
        '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND metric IN ({metrics:Array(String)}) GROUP BY ci_id, metric',
      { tenantId, metrics: [...FLEET_METRIC_NAMES] },
    );
    const out = new Map<string, { values: Partial<Record<FleetMeasure, number>>; at: number }>();
    for (const r of rows) {
      const measure = fleetMeasureOfMetric(r.metric);
      if (measure === null) continue;
      const entry = out.get(r.ci) ?? { values: {}, at: 0 };
      entry.values[measure] = Number(r.v);
      entry.at = Math.max(entry.at, Number(r.ms));
      out.set(r.ci, entry);
    }
    return out;
  }

  /** The current CIs among the ids, one array parameter (an IN list of 100k ids exceeds Postgres's bind limit). */
  private async cis(tenantId: string, ids: readonly string[]): Promise<CiRow[]> {
    if (ids.length === 0) return [];
    const a = FLEET_ATTRIBUTES;
    return this.prisma.client.$queryRaw<CiRow[]>(Prisma.sql`
      SELECT id::text AS id, "displayName" AS name, layer::text AS layer,
        NULLIF(attributes->>${a.site}, '') AS site,
        COALESCE(NULLIF(attributes->>${a.fqdn}, ''), NULLIF(identity->>${a.fqdn}, ''), NULLIF(attributes->>${a.ipAddress}, ''),
          NULLIF(identity->>${a.ipAddress}, ''), NULLIF(identity->>${a.managementIp}, '')) AS address
      FROM cis WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND id = ANY(${ids}::uuid[])`);
  }

  /** Health of every CI the BSM engine has judged; the rest are unknown. */
  private async health(tenantId: string): Promise<Map<string, HealthState>> {
    const known = HEALTH_STATES.filter((h) => h !== 'unknown');
    const rows = await this.graph.repo.readOnly<{ id: string; health: HealthState }>(
      'MATCH (c:Ci {tenantId: $tenantId}) WHERE c.health IN $known RETURN c.id AS id, c.health AS health',
      { tenantId, known },
    );
    return new Map(rows.map((r) => [r.id, r.health]));
  }
}

