// REQ-AI-005 (ADR-054) — cloud recommendations: each cloud resource's state, SKU and monthly cost (its CI in Postgres)
// and its load (cloud.resource.load_percent in ClickHouse: the samples of the last CLOUD_ADVICE.lookbackDays, else the
// latest one) through the recommendation model (@openmap/assistant recommendCloud). Computed on request; nothing is
// stored, so the advice follows the estate as collectors report it.
import { Injectable } from '@nestjs/common';
import { recommendCloud, type CloudResourceFacts } from '@openmap/assistant';
import { CLOUD_ADVICE, TIME } from '@openmap/constants';
import { LAYER_HEADLINE_METRIC, type CloudRecommendationKind } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { ClickHouseService } from '../db/clickhouse.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';

export interface CloudRecommendationView {
  ciId: string;
  kind: CloudRecommendationKind;
  savingUsd: number;
  averageLoad: number | null;
  peakLoad: number | null;
  samples: number;
  loadAt: Date | null;
  sku: string | null;
  state: string | null;
  monthlyCostUsd: number | null;
  owner: string | null;
  environment: string | null;
}

export interface CloudAdviceView {
  items: CloudRecommendationView[];
  /** Cloud resources the model looked at. */
  resources: number;
  monthlySavingUsd: number;
  asOf: Date;
}

interface ResourceRow {
  id: string;
  name: string;
  resource_type: string | null;
  state: string | null;
  cost: string | null;
  sku: string | null;
  owner: string | null;
  environment: string | null;
}

interface LoadRow {
  ci: string;
  loads: number[];
  ms: string | number;
}

const LOAD_METRIC = LAYER_HEADLINE_METRIC.cloud.metric;

@Injectable()
export class CloudAdviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clickhouse: ClickHouseService,
    private readonly metrics: MetricsService,
  ) {}

  async advise(tenantId: string, now: Date = new Date()): Promise<CloudAdviceView> {
    return withSpan(TRACER_NAME, 'cloud.advise', { 'openmap.tenant': tenantId }, async () => {
      const a = CLOUD_ADVICE.attributes;
      const rows = await this.prisma.client.$queryRaw<ResourceRow[]>(Prisma.sql`
        SELECT id::text AS id, "displayName" AS name, attributes->>${a.type} AS resource_type, attributes->>${a.state} AS state,
          attributes->>${a.cost} AS cost, attributes->>${a.sku} AS sku, attributes->>${a.owner} AS owner, attributes->>${a.environment} AS environment
        FROM cis WHERE "tenantId" = ${tenantId}::uuid AND type = 'cloud_resource' AND "validTo" IS NULL`);
      const loads = await this.loads(tenantId, rows.map((r) => r.id), now);
      const facts: CloudResourceFacts[] = rows.map((r) => {
        const l = loads.get(r.id);
        const cost = r.cost === null ? null : Number(r.cost);
        return {
          ciId: r.id,
          name: r.name,
          resourceType: r.resource_type,
          state: r.state,
          monthlyCostUsd: cost !== null && Number.isFinite(cost) ? cost : null,
          sku: r.sku,
          loads: l?.loads ?? [],
          loadAt: l?.at ?? null,
        };
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const recs = recommendCloud(facts);
      for (const r of recs) this.metrics.cloudRecommendations.inc({ kind: r.kind });
      const items = recs.map((r) => {
        const row = byId.get(r.ciId);
        const fact = facts.find((f) => f.ciId === r.ciId);
        return {
          ...r,
          loadAt: fact?.loadAt === null || fact?.loadAt === undefined ? null : new Date(fact.loadAt),
          sku: row?.sku ?? null,
          state: row?.state ?? null,
          monthlyCostUsd: fact?.monthlyCostUsd ?? null,
          owner: row?.owner ?? null,
          environment: row?.environment ?? null,
        };
      });
      const saving = items.reduce((n, i) => n + i.savingUsd, 0);
      return { items, resources: rows.length, monthlySavingUsd: Number(saving.toFixed(CLOUD_ADVICE.moneyDecimals)), asOf: now };
    });
  }

  /** Load samples per resource over the lookback window; a resource with none there keeps its latest sample. */
  private async loads(tenantId: string, ids: readonly string[], now: Date): Promise<Map<string, { loads: number[]; at: number }>> {
    const out = new Map<string, { loads: number[]; at: number }>();
    if (ids.length === 0) return out;
    const db = this.clickhouse.database;
    // `ci`, not `ci_id`: ClickHouse applies SELECT aliases in WHERE, so a string alias would break the UUID filter.
    const recent = await this.clickhouse.query<LoadRow>(
      'cloud_advice_loads',
      'SELECT toString(ci_id) AS ci, groupArray(value) AS loads, toUnixTimestamp64Milli(max(ts)) AS ms FROM ' + db +
        '.metrics WHERE tenant_id = {tenantId:UUID} AND metric = {metric:String} AND ci_id IN ({ids:Array(UUID)}) AND ts >= fromUnixTimestamp64Milli({since:Int64}) GROUP BY ci_id',
      { tenantId, metric: LOAD_METRIC, ids: [...ids], since: now.getTime() - CLOUD_ADVICE.lookbackDays * TIME.msPerDay },
    );
    for (const r of recent) out.set(r.ci, { loads: r.loads.map(Number), at: Number(r.ms) });
    const missing = ids.filter((id) => !out.has(id));
    if (missing.length === 0) return out;
    const latest = await this.clickhouse.query<LoadRow>(
      'cloud_advice_latest',
      'SELECT toString(ci_id) AS ci, [argMax(value, ts)] AS loads, toUnixTimestamp64Milli(max(ts)) AS ms FROM ' + db +
        '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND metric = {metric:String} AND ci_id IN ({ids:Array(UUID)}) GROUP BY ci_id',
      { tenantId, metric: LOAD_METRIC, ids: missing },
    );
    for (const r of latest) out.set(r.ci, { loads: r.loads.map(Number), at: Number(r.ms) });
    return out;
  }
}
