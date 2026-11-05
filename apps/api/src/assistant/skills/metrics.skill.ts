// REQ-AI-007 (ADR-028) — `metrics.latest`: measurements from ClickHouse (CPU, memory, throughput, power, IOPS, PUE,
// patch compliance), aggregated over the latest sample per CI. The metric name is the catalogue's, never the
// person's words; a scope word narrows the CIs through Postgres first. Rankings come back with the CI names so the
// console can link them.
import { Inject, Injectable } from '@nestjs/common';
import { ASSISTANT } from '@openmap/constants';
import { MEASUREMENTS, type RankedCi, type SkillParams, type Summary } from '@openmap/assistant';
import { Prisma } from '@openmap/db';
import { CI_REPOSITORY, type CiRepository } from '../../ci/ci.repository.js';
import { ClickHouseService } from '../../db/clickhouse.service.js';
import { PrismaService } from '../../db/prisma.service.js';
import { AssistantCatalogueService } from '../catalogue.service.js';
import { failed, paramsOf, result, startTimer, type SkillContext, type SkillOutcome } from './skill.js';

type Params = Extract<SkillParams, { skill: 'metrics.latest' }>;

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

@Injectable()
export class MetricsSkill {
  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly prisma: PrismaService,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly catalogue: AssistantCatalogueService,
  ) {}

  async run(step: Params, context: SkillContext): Promise<SkillOutcome> {
    const elapsed = startTimer();
    const scope = await this.catalogue.resolveFilters(context.tenantId, step.filters);
    const notes: Summary[] = scope.unresolved.map((value) => ({ kind: 'unresolvedFilter', value }));
    const filterTerms = scope.resolved.map((f) => f.term);
    const db = this.clickhouse.database;
    try {
      // A scope word narrows to the CIs that carry it; without one the metric name already implies the type.
      let ids: string[] | null = null;
      if (scope.resolved.length > 0) {
        const where = Prisma.join(
          scope.resolved.map((f) => Prisma.sql`c.attributes->>${f.key} = ${f.value}`),
          ' AND ',
        );
        const rows = await this.prisma.client.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT c.id FROM cis c WHERE c."tenantId" = ${context.tenantId}::uuid AND c."validTo" IS NULL AND c.type = ${step.type}::"CiType" AND ${where}`);
        ids = rows.map((r) => r.id);
      }
      const idClause = ids === null ? '' : ' AND ci_id IN ({ids:Array(UUID)})';
      const latest = 'SELECT ci_id, argMax(value, ts) AS v, max(ts) AS t FROM ' + db + '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND metric = {metric:String}' + idClause + ' GROUP BY ci_id';
      const params: Record<string, string | number | readonly string[]> = { tenantId: context.tenantId, metric: step.metric, ...(ids === null ? {} : { ids }) };
      const unit = MEASUREMENTS[step.metric].unit;

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
          results: [result(step, 'clickhouse', sql, { ...params, topN: step.topN }, ranked.map((r) => ({ ci: r.name, value: r.value })), elapsed(), summary, ranked.map((r) => r.ciId)), ...notes.map((n) => result(step, 'catalogue', 'resolveFilters', { filters: step.filters }, [], 0, n))],
          clarification: null,
        };
      }

      const sql = 'SELECT count() AS count, avg(v) AS avg, sum(v) AS sum, min(v) AS min, max(v) AS max, toUnixTimestamp64Milli(max(t)) AS ts_ms FROM (' + latest + ')';
      const [row] = await this.clickhouse.query<AggregateRow>('assistant_aggregate', sql, params);
      const count = Number(row?.count ?? 0);
      const value = row === undefined || count === 0 ? null : step.aggregate === 'sum' ? row.sum : row.avg;
      const summary: Summary = { kind: 'measurement', metric: step.metric, type: step.type, aggregate: step.aggregate === 'sum' ? 'sum' : 'avg', value, unit, count, asOf: tsOf(row?.ts_ms), ranked: [], filters: filterTerms };
      return {
        results: [result(step, 'clickhouse', sql, params, row === undefined ? [] : [{ count, avg: row.avg, sum: row.sum, min: row.min, max: row.max }], elapsed(), summary), ...notes.map((n) => result(step, 'catalogue', 'resolveFilters', { filters: step.filters }, [], 0, n))],
        clarification: null,
      };
    } catch (err) {
      return { results: [failed(step, 'clickhouse', 'metrics.latest', paramsOf([step.metric, step.type]), elapsed(), err instanceof Error ? err.message : String(err))], clarification: null };
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
