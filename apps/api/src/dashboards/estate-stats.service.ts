// REQ-UI-030 — the estate aggregate behind dashboard widgets (ADR-020): one query composes the register, licence,
// vulnerability, plan, power, IPAM, Node, integration and incident facts the screens already compute, plus the
// daily trend series from ClickHouse, so a dashboard paints from one round trip instead of one per tile.
import { Injectable } from '@nestjs/common';
import { DASHBOARD, IPAM, TIME } from '@openmap/constants';
import { ASSET_STAGES, PLAN_STATUSES, type AssetStage } from '@openmap/contracts';

type PlanStatus = (typeof PLAN_STATUSES)[number];
import { AssetsService } from '../assets/assets.service.js';
import { ClickHouseService } from '../db/clickhouse.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { DcimService } from '../dcim/dcim.service.js';
import { DiscoveryService } from '../discovery/discovery.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { IpamService } from '../ipam/ipam.service.js';
import { ServicesService } from '../services/services.service.js';
import { SoftwareService } from '../software/software.service.js';
import type { EstateStatsView, EstateTrendView, MoneyTotal, StageCountView } from './dashboards.types.js';

const CRITICAL_SEVERITY = 'critical';
const NODE_ONLINE = 'online';
const INTEGRATION_HEALTHY = 'healthy';

interface DayCount {
  day: string;
  n: number;
}

/** A ClickHouse row: the day is aliased `d`, never `day`, because an alias named like a column replaces it in WHERE. */
interface DayRow {
  d: string;
  n: number | string;
}

function fromRows(rows: readonly DayRow[]): DayCount[] {
  return rows.map((r) => ({ day: r.d, n: Number(r.n) }));
}

/** Sums amounts per currency; a tenant that buys in two currencies gets two totals, never a mixed one. */
export function sumMoney(
  entries: ReadonlyArray<{ amount: number; currency: string } | null | undefined>,
): MoneyTotal[] {
  const totals = new Map<string, number>();
  for (const e of entries) {
    if (!e) continue;
    totals.set(e.currency, (totals.get(e.currency) ?? 0) + e.amount);
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ amount, currency }))
    .sort((a, b) => b.amount - a.amount);
}

/** The last `DASHBOARD.trendDays` calendar days as ISO dates, oldest first. */
export function trendDays(now: Date): string[] {
  const out: string[] = [];
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = DASHBOARD.trendDays - 1; i >= 0; i -= 1)
    out.push(new Date(start - i * TIME.msPerDay).toISOString().slice(0, 'YYYY-MM-DD'.length));
  return out;
}

export function countsByDay(days: readonly string[], rows: readonly DayCount[]): number[] {
  const byDay = new Map(rows.map((r) => [r.day.slice(0, 'YYYY-MM-DD'.length), Number(r.n)]));
  return days.map((d) => byDay.get(d) ?? 0);
}

function withinDays(iso: string | null, days: number, now: number): boolean {
  if (iso === null) return false;
  const t = Date.parse(iso);
  return t >= now && t - now <= days * TIME.msPerDay;
}

@Injectable()
export class EstateStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clickhouse: ClickHouseService,
    private readonly assets: AssetsService,
    private readonly software: SoftwareService,
    private readonly dcim: DcimService,
    private readonly ipam: IpamService,
    private readonly discovery: DiscoveryService,
    private readonly integrations: IntegrationsService,
    private readonly services: ServicesService,
  ) {}

  async stats(tenantId: string, now = new Date()): Promise<EstateStatsView> {
    const [
      assetsByStage,
      products,
      vulnerabilities,
      plans,
      racks,
      subnets,
      nodes,
      integrations,
      incidents,
      trend,
    ] = await Promise.all([
      this.assetsByStage(tenantId),
      this.software.software(tenantId, null, false, DASHBOARD.statsRowCap),
      this.software.vulnerabilitySummaries(tenantId, null, false, null),
      this.assets.plans(tenantId, []),
      this.dcim.racks(tenantId, null),
      this.ipam.subnets(tenantId, null),
      this.discovery.nodes(tenantId),
      this.integrations.list(tenantId, null),
      this.services.incidents(tenantId, false, null),
      this.trend(tenantId, now),
    ]);
    const nowMs = now.getTime();
    const licensed = products.filter((p) => p.licence !== null);
    const planRows = PLAN_STATUSES.map((status: PlanStatus) => {
      const of = plans.filter((p) => p.status === status);
      return { status, count: of.length, estimatedCost: sumMoney(of.map((p) => p.estimatedCost)) };
    });
    return {
      assetsByStage,
      licences: {
        products: products.length,
        licensed: licensed.length,
        overDeployed: licensed.filter((p) => p.licence?.overDeployed === true).length,
        expiringSoon: licensed.filter((p) =>
          withinDays(p.licence?.expiresAt ?? null, DASHBOARD.licenceExpiryDays, nowMs),
        ).length,
        expired: licensed.filter((p) => p.licence?.expired === true).length,
        annualCost: sumMoney(licensed.map((p) => p.licence?.annualCost)),
      },
      vulnerabilities: {
        total: vulnerabilities.length,
        critical: vulnerabilities.filter((v) => v.severity === CRITICAL_SEVERITY).length,
        exploited: vulnerabilities.filter((v) => v.exploited).length,
        cisaKev: vulnerabilities.filter((v) => v.cisaKev).length,
        internetFacing: vulnerabilities.filter((v) => v.internetFacing).length,
        patchAvailable: vulnerabilities.filter((v) => v.patchAvailable).length,
        affectedHosts: vulnerabilities.reduce((sum, v) => sum + v.affectedHosts, 0),
      },
      endOfSupport: products.filter((p) => p.endOfSupport !== null && Date.parse(p.endOfSupport) <= nowMs)
        .length,
      plans: planRows,
      power: {
        racks: racks.length,
        ratedWatts: racks.reduce((sum, r) => sum + r.powerFeeds.reduce((s, f) => s + f.ratedWatts, 0), 0),
        currentWatts: racks.reduce((sum, r) => sum + r.powerFeeds.reduce((s, f) => s + f.currentWatts, 0), 0),
      },
      ipam: {
        subnets: subnets.length,
        averageUtilisationPercent:
          subnets.length === 0
            ? 0
            : subnets.reduce((sum, s) => sum + s.utilisationPercent, 0) / subnets.length,
        critical: subnets.filter((s) => s.utilisationPercent >= IPAM.criticalUtilisationPercent).length,
      },
      nodes: { total: nodes.length, online: nodes.filter((n) => n.status === NODE_ONLINE).length },
      integrations: {
        total: integrations.length,
        healthy: integrations.filter((i) => i.health === INTEGRATION_HEALTHY).length,
        failedLastHour: integrations.reduce((sum, i) => sum + i.failedLastHour, 0),
      },
      incidentsOpen: incidents.filter((i) => i.resolvedAt === null).length,
      trend: {
        ...trend,
        incidents: countsByDay(
          trend.days,
          incidents.map((i) => ({ day: i.openedAt, n: 1 })).reduce<DayCount[]>(foldDays, []),
        ),
      },
    };
  }

  /** Register counts and purchase totals per stage, straight from Postgres (every stage, zero rows included). */
  private async assetsByStage(tenantId: string): Promise<StageCountView[]> {
    const groups = await this.prisma.client.assetRecord.groupBy({
      by: ['stage', 'purchaseCostCurrency'],
      where: { tenantId },
      _count: { _all: true },
      _sum: { purchaseCostAmount: true },
    });
    return ASSET_STAGES.map((stage: AssetStage) => {
      const of = groups.filter((g) => g.stage === stage);
      return {
        stage,
        count: of.reduce((sum, g) => sum + g._count._all, 0),
        purchaseCost: sumMoney(
          of.map((g) =>
            g.purchaseCostCurrency === null || g._sum.purchaseCostAmount === null
              ? null
              : { amount: Number(g._sum.purchaseCostAmount.toString()), currency: g.purchaseCostCurrency },
          ),
        ),
      };
    });
  }

  /** Daily counts over the trend window from the analytics store; a day without rows counts zero. */
  private async trend(tenantId: string, now: Date): Promise<Omit<EstateTrendView, 'incidents'>> {
    const days = trendDays(now);
    const from = days[0] ?? '';
    const db = this.clickhouse.database;
    const [cis, runs, events] = await Promise.all([
      this.clickhouse.query<DayRow>(
        'dashboard_cis_by_day',
        'SELECT toString(day) AS d, uniqMerge(cis) AS n FROM ' +
          db +
          '.layer_counts_daily WHERE tenant_id = {tenantId:UUID} AND day >= {from:Date} GROUP BY day ORDER BY day',
        { tenantId, from },
      ),
      this.clickhouse.query<DayRow>(
        'dashboard_runs_by_day',
        'SELECT toString(toDate(started_at)) AS d, count() AS n FROM ' +
          db +
          '.discovery_runs WHERE tenant_id = {tenantId:UUID} AND toDate(started_at) >= {from:Date} GROUP BY d ORDER BY d',
        { tenantId, from },
      ),
      this.clickhouse.query<DayRow>(
        'dashboard_events_by_day',
        'SELECT toString(toDate(time)) AS d, count() AS n FROM ' +
          db +
          '.events WHERE tenant_id = {tenantId:UUID} AND toDate(time) >= {from:Date} GROUP BY d ORDER BY d',
        { tenantId, from },
      ),
    ]);
    return {
      days: days.map((d) => d + 'T00:00:00.000Z'),
      cis: countsByDay(days, fromRows(cis)),
      discoveryRuns: countsByDay(days, fromRows(runs)),
      events: countsByDay(days, fromRows(events)),
    };
  }
}

function foldDays(acc: DayCount[], row: DayCount): DayCount[] {
  const day = row.day.slice(0, 'YYYY-MM-DD'.length);
  const hit = acc.find((r) => r.day === day);
  if (hit) hit.n += row.n;
  else acc.push({ day, n: row.n });
  return acc;
}
