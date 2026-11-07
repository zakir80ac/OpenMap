// REQ-AI-007 REQ-AI-008 (ADR-028) — `metrics.latest`: measurements from ClickHouse (CPU, memory, throughput, power,
// IOPS, PUE, patch compliance), aggregated over the latest sample per CI; `metrics.series`: the same measurement over
// a rolling window ("CPU of host X over the last 7 days"), averaged into buckets with the trend from the first to
// the last bucket. The metric name is the catalogue's, never the person's words; a named CI narrows to it, a scope
// word narrows the CIs through Postgres first. Rankings come back with the CI names so the console can link them.
import { Inject, Injectable } from '@nestjs/common';
import { ASSISTANT, BSM, TIME } from '@openmap/constants';
import { MEASUREMENTS, type RankedCi, type SkillParams, type Summary } from '@openmap/assistant';
import { Prisma } from '@openmap/db';
import { CI_REPOSITORY, type CiRepository } from '../../ci/ci.repository.js';
import type { CiRecord } from '../../ci/ci.types.js';
import { ClickHouseService, type QueryParams } from '../../db/clickhouse.service.js';
import { PrismaService } from '../../db/prisma.service.js';
import { AssistantCatalogueService } from '../catalogue.service.js';
import { EntityResolver } from '../entity.resolver.js';
import { failed, nameClarification, paramsOf, result, settled, startTimer, type SkillContext, type SkillOutcome } from './skill.js';

type Params = Extract<SkillParams, { skill: 'metrics.latest' }>;
type SeriesParams = Extract<SkillParams, { skill: 'metrics.series' }>;

interface AggregateRow {
  count: string | number;
  avg: number | null;
  sum: number | null;
  min: number | null;
  max: number | null;
  ts_ms: string | number | null;
}

interface RankedRow {
  ci_id: string;
  v: number;
}

interface BucketRow {
  bucket_ms: string | number;
  avg: number;
  min: number;
  max: number;
  samples: string | number;
  cis: string | number;
}

/** The CIs a step is about: the named one, or every CI of the type carrying the resolved scope values, or all (null). */
interface Scope {
  ids: string[] | null;
  named: CiRecord | null;
  filterTerms: string[];
  notes: Summary[];
}

@Injectable()
export class MetricsSkill {
  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly prisma: PrismaService,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly catalogue: AssistantCatalogueService,
    private readonly resolver: EntityResolver,
  ) {}

  private async scopeOf(
    step: { type: Params['type']; names: string[]; filters: string[] },
    context: SkillContext,
  ): Promise<{ scope: Scope | null; clarification: SkillOutcome['clarification'] }> {
    const name = step.names[0];
    if (name !== undefined) {
      // "CPU of host X": the metric's subject type narrows an ambiguous name before the person is asked.
      let resolution = await this.resolver.resolve(context.tenantId, name);
      if (resolution.exact.length > 1) {
        const narrowed = await this.resolver.resolve(context.tenantId, name, [step.type]);
        if (narrowed.exact.length > 0) resolution = narrowed;
      }
      const ci = settled(resolution);
      if (ci === null) return { scope: null, clarification: nameClarification(resolution, context.question) };
      return { scope: { ids: [ci.id], named: ci, filterTerms: [], notes: [] }, clarification: null };
    }
    const resolved = await this.catalogue.resolveFilters(context.tenantId, step.filters);
    const notes: Summary[] = resolved.unresolved.map((value) => ({ kind: 'unresolvedFilter', value }));
    // Always scoped to the step's type: a metric is sampled on more than one type (every hardware CI carries the host
    // load headline, BMCs included), and "CPU of hosts" is about hosts only.
    const where =
      resolved.resolved.length === 0
        ? Prisma.sql`TRUE`
        : Prisma.join(
            resolved.resolved.map((f) => Prisma.sql`c.attributes->>${f.key} = ${f.value}`),
            ' AND ',
          );
    const rows = await this.prisma.client.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT c.id FROM cis c WHERE c."tenantId" = ${context.tenantId}::uuid AND c."validTo" IS NULL AND c.type = ${step.type}::"CiType" AND ${where}`);
    return {
      scope: { ids: rows.map((r) => r.id), named: null, filterTerms: resolved.resolved.map((f) => f.term), notes },
      clarification: null,
    };
  }

  async run(step: Params, context: SkillContext): Promise<SkillOutcome> {
    const elapsed = startTimer();
    const db = this.clickhouse.database;
    try {
      const scoped = await this.scopeOf(step, context);
      if (scoped.scope === null) return { results: [], clarification: scoped.clarification };
      const { ids, filterTerms, notes } = scoped.scope;
      const idClause = ids === null ? '' : ' AND ci_id IN ({ids:Array(UUID)})';
      const latest = 'SELECT ci_id, argMax(value, ts) AS v, max(ts) AS t FROM ' + db + '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND metric = {metric:String}' + idClause + ' GROUP BY ci_id';
      const params: QueryParams = { tenantId: context.tenantId, metric: step.metric, ...(ids === null ? {} : { ids }) };
      const unit = MEASUREMENTS[step.metric].unit;
      const noteResults = notes.map((n) => result(step, 'catalogue', 'resolveFilters', { filters: step.filters }, [], 0, n));

      if (step.aggregate === 'max' || step.aggregate === 'min') {
        const sql = 'SELECT ci_id, v FROM (' + latest + ') ORDER BY v ' + (step.aggregate === 'max' ? 'DESC' : 'ASC') + ' LIMIT {topN:UInt32}';
        const countSql = 'SELECT count() AS count, toUnixTimestamp64Milli(max(t)) AS ts_ms FROM (' + latest + ')';
        const [rows, [totals]] = await Promise.all([
          this.clickhouse.query<RankedRow>('assistant_ranked', sql, { ...params, topN: step.topN }),
          this.clickhouse.query<{ count: string | number; ts_ms: string | number | null }>('assistant_ranked_count', countSql, params),
        ]);
        const names = new Map((await this.cis.findByIds(context.tenantId, rows.map((r) => r.ci_id))).map((c) => [c.id, c.displayName]));
        const ranked: RankedCi[] = rows.map((r) => ({ ciId: r.ci_id, name: names.get(r.ci_id) ?? r.ci_id, value: r.v }));
        const summary: Summary = { kind: 'measurement', metric: step.metric, type: step.type, aggregate: step.aggregate, value: ranked[0]?.value ?? null, unit, count: Number(totals?.count ?? 0), asOf: tsOf(totals?.ts_ms), ranked, filters: filterTerms };
        return {
          results: [result(step, 'clickhouse', sql, { ...params, topN: step.topN }, ranked.map((r) => ({ ci: r.name, value: r.value })), elapsed(), summary, ranked.map((r) => r.ciId)), ...noteResults],
          clarification: null,
        };
      }

      const sql = 'SELECT count() AS count, avg(v) AS avg, sum(v) AS sum, min(v) AS min, max(v) AS max, toUnixTimestamp64Milli(max(t)) AS ts_ms FROM (' + latest + ')';
      const [row] = await this.clickhouse.query<AggregateRow>('assistant_aggregate', sql, params);
      const count = Number(row?.count ?? 0);
      const value = row === undefined || count === 0 ? null : step.aggregate === 'sum' ? row.sum : row.avg;
      // A named CI has one latest sample: the ranking form names it so the answer says which CI the figure is for.
      const named = scoped.scope.named;
      const ranked: RankedCi[] = named !== null && value !== null ? [{ ciId: named.id, name: named.displayName, value }] : [];
      const summary: Summary = { kind: 'measurement', metric: step.metric, type: step.type, aggregate: step.aggregate === 'sum' ? 'sum' : 'avg', value, unit, count, asOf: tsOf(row?.ts_ms), ranked, filters: filterTerms };
      return {
        results: [result(step, 'clickhouse', sql, params, row === undefined ? [] : [{ count, avg: row.avg, sum: row.sum, min: row.min, max: row.max }], elapsed(), summary, named === null ? [] : [named.id]), ...noteResults],
        clarification: null,
      };
    } catch (err) {
      return { results: [failed(step, 'clickhouse', 'metrics.latest', paramsOf([step.metric, step.type]), elapsed(), err instanceof Error ? err.message : String(err))], clarification: null };
    }
  }

  /** The measurement over a rolling window, averaged into buckets; the window ends `offsetHours` ago. */
  async series(step: SeriesParams, context: SkillContext): Promise<SkillOutcome> {
    const elapsed = startTimer();
    const db = this.clickhouse.database;
    try {
      const scoped = await this.scopeOf(step, context);
      if (scoped.scope === null) return { results: [], clarification: scoped.clarification };
      const { ids, named, notes } = scoped.scope;
      const now = Date.now();
      const to = new Date(now - step.offsetHours * TIME.msPerHour);
      const from = new Date(to.getTime() - step.hours * TIME.msPerHour);
      const bucketSeconds = Math.max(TIME.secondsPerMinute, Math.round((step.hours * TIME.msPerHour) / TIME.msPerSecond / ASSISTANT.seriesBuckets));
      const idClause = ids === null ? '' : ' AND ci_id IN ({ids:Array(UUID)})';
      // Parameters bind as strings for DateTime64: cast in SQL (packages/db ClickHouse notes).
      const sql =
        'SELECT toUnixTimestamp64Milli(toDateTime64(toStartOfInterval(ts, INTERVAL {bucket:UInt32} second), 3)) AS bucket_ms, avg(value) AS avg, min(value) AS min, max(value) AS max, count() AS samples, uniqExact(ci_id) AS cis FROM ' +
        db +
        '.metrics WHERE tenant_id = {tenantId:UUID} AND metric = {metric:String} AND ts >= toDateTime64({from:String}, 3) AND ts < toDateTime64({to:String}, 3)' +
        idClause +
        ' GROUP BY bucket_ms ORDER BY bucket_ms';
      const params: QueryParams = {
        tenantId: context.tenantId,
        metric: step.metric,
        from: from.toISOString().replace('T', ' ').replace('Z', ''),
        to: to.toISOString().replace('T', ' ').replace('Z', ''),
        bucket: bucketSeconds,
        hours: step.hours,
        offsetHours: step.offsetHours,
        ...(ids === null ? {} : { ids }),
      };
      const rows = await this.clickhouse.query<BucketRow>('assistant_series', sql, params);
      const samples = rows.reduce((n, r) => n + Number(r.samples), 0);
      const weighted = rows.reduce((n, r) => n + r.avg * Number(r.samples), 0);
      const first = rows[0]?.avg ?? null;
      const last = rows.at(-1)?.avg ?? null;
      const trendPercent =
        first === null || last === null || first === 0 ? null : ((last - first) / Math.abs(first)) * BSM.percentScale;
      const summary: Summary = {
        kind: 'series',
        metric: step.metric,
        type: step.type,
        ci: named === null ? null : { ciId: named.id, name: named.displayName },
        count: rows.length === 0 ? 0 : Math.max(...rows.map((r) => Number(r.cis))),
        samples,
        from: from.toISOString(),
        to: to.toISOString(),
        hours: step.hours,
        avg: samples === 0 ? null : weighted / samples,
        min: rows.length === 0 ? null : Math.min(...rows.map((r) => r.min)),
        max: rows.length === 0 ? null : Math.max(...rows.map((r) => r.max)),
        first,
        last,
        trendPercent,
        unit: MEASUREMENTS[step.metric].unit,
      };
      const evidenceRows = rows.map((r) => ({ at: new Date(Number(r.bucket_ms)).toISOString(), avg: r.avg, min: r.min, max: r.max, samples: Number(r.samples) }));
      return {
        results: [
          result(step, 'clickhouse', sql, params, evidenceRows, elapsed(), summary, named === null ? [] : [named.id]),
          ...notes.map((n) => result(step, 'catalogue', 'resolveFilters', { filters: step.filters }, [], 0, n)),
        ],
        clarification: null,
      };
    } catch (err) {
      return { results: [failed(step, 'clickhouse', 'metrics.series', paramsOf([step.metric, step.type, step.hours]), elapsed(), err instanceof Error ? err.message : String(err))], clarification: null };
    }
  }
}

function tsOf(ms: string | number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/** Keeps the ranking size within the catalogue's bound whatever the question asked for. */
export function boundedTopN(n: number): number {
  return Math.max(1, Math.min(n, ASSISTANT.skillRowLimit));
}
