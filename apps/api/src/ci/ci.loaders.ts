// REQ-CMDB-001 REQ-CMDB-038 — per-request loaders for CIs, relationships, graph health and headline metrics,
// created once per GraphQL request so nested fields batch into single Postgres, Memgraph and ClickHouse round trips.
import { Inject, Injectable } from '@nestjs/common';
import { HEADLINE_METRIC_NAMES } from '@openmap/contracts';
import { BatchLoader } from '../common/batch-loader.js';
import { ClickHouseService } from '../db/clickhouse.service.js';
import { GraphService } from '../db/graph.service.js';
import { CI_REPOSITORY, type CiRepository } from './ci.repository.js';
import type { CiRecord, HealthState, MetricPoint, RelationshipRecord } from './ci.types.js';

export interface CiLoaders {
  ci: BatchLoader<string, CiRecord>;
  relationship: BatchLoader<string, RelationshipRecord>;
  health: BatchLoader<string, HealthState>;
  /** Latest headline-metric samples of a CI, keyed by metric name; a CI with no sample resolves to null. */
  metrics: BatchLoader<string, Map<string, MetricPoint>>;
}

const HEALTH_QUERY = 'MATCH (c:Ci {tenantId: $tenantId}) WHERE c.id IN $ids RETURN c.id AS id, c.health AS health';

/**
 * One primary-key range read per page: metrics_latest is ordered by (tenant, ci, metric), and argMax over ts
 * tolerates parts the ReplacingMergeTree has not merged yet. The instant comes back as epoch milliseconds so no
 * ClickHouse date format needs parsing.
 */
function headlineMetricsQuery(database: string): string {
  return (
    'SELECT ci_id, metric, argMax(value, ts) AS value, toUnixTimestamp64Milli(max(ts)) AS ts_ms FROM ' +
    database +
    '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND ci_id IN ({ids:Array(UUID)}) AND metric IN ({metrics:Array(String)}) GROUP BY ci_id, metric'
  );
}

interface HeadlineRow {
  ci_id: string;
  metric: string;
  value: number;
  /** Int64 columns arrive as strings in JSONEachRow. */
  ts_ms: string | number;
}

@Injectable()
export class CiLoaderFactory {
  constructor(
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly graph: GraphService,
    private readonly clickhouse: ClickHouseService,
  ) {}

  create(tenantId: string): CiLoaders {
    return {
      ci: new BatchLoader(async (ids) => new Map((await this.cis.findByIds(tenantId, ids)).map((c) => [c.id, c]))),
      relationship: new BatchLoader(async (ids) => new Map((await this.cis.relationshipsByIds(tenantId, ids)).map((r) => [r.id, r]))),
      health: new BatchLoader(async (ids) => {
        const rows = await this.graph.repo.readOnly<{ id: string; health: HealthState | null }>(HEALTH_QUERY, { tenantId, ids: [...ids] });
        return new Map(rows.map((r) => [r.id, r.health ?? 'unknown']));
      }),
      metrics: new BatchLoader(async (ids) => {
        const rows = await this.clickhouse.query<HeadlineRow>('headline_metrics', headlineMetricsQuery(this.clickhouse.database), { tenantId, ids: [...ids], metrics: HEADLINE_METRIC_NAMES });
        const byCi = new Map<string, Map<string, MetricPoint>>();
        for (const row of rows) {
          const points = byCi.get(row.ci_id) ?? new Map<string, MetricPoint>();
          points.set(row.metric, { metric: row.metric, value: row.value, observedAt: new Date(Number(row.ts_ms)).toISOString() });
          byCi.set(row.ci_id, points);
        }
        return byCi;
      }),
    };
  }
}
