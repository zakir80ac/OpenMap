// REQ-BSM-007 (ADR-025) — the Sites screen's read model:
// - the tenant's site and site_link CIs with their DR role, criticality and replication flag;
// - each link's latest probe (ClickHouse metrics_latest) and the health the BSM engine derives from it, using the
//   same linkHealth;
// - the healthy paths each site has;
// - the readiness findings with their incidents.
import { Inject, Injectable } from '@nestjs/common';
import { linkHealth, type LinkSnapshot } from '@openmap/bsm-engine';
import { READINESS, TIME } from '@openmap/constants';
import { CONNECTIVITY_ATTRIBUTES, LINK_METRICS, LINK_METRIC_NAMES, SITE_DR_ROLES } from '@openmap/contracts';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { isoOf, toIso } from '../common/time.js';
import { ENV, type Env } from '../config/env.module.js';
import { ClickHouseService } from '../db/clickhouse.service.js';
import { PrismaService } from '../db/prisma.service.js';

export interface ConnectivitySiteView {
  ci: CiRecord;
  code: string;
  drRole: string;
  criticality: number | null;
  healthyPaths: number;
}

export interface ConnectivityLinkView {
  ci: CiRecord;
  fromSite: string | null;
  toSite: string | null;
  kind: string | null;
  provider: string | null;
  role: string | null;
  replication: boolean;
  diversePaths: number;
  probeTarget: string | null;
  reachable: boolean | null;
  latencyMs: number | null;
  lossPercent: number | null;
  probedAt: string | null;
  slaLatencyMs: number | null;
}

export interface ReadinessFindingView {
  id: string;
  rule: string;
  subjectCiId: string;
  detail: string;
  state: string;
  openedAt: string;
  clearedAt: string | null;
  incidentId: string | null;
}

export interface ConnectivityView {
  sites: ConnectivitySiteView[];
  links: ConnectivityLinkView[];
  findings: ReadinessFindingView[];
  probeIntervalSeconds: number;
}

interface LatestRow {
  ci: string;
  metric: string;
  v: number;
  ms: string | number;
}

type Latest = Partial<Record<string, { value: number; at: number }>>;

const DR_ROLES: ReadonlySet<string> = new Set(SITE_DR_ROLES);

function attr(ci: CiRecord, key: string, from: 'attributes' | 'identity' = 'attributes'): unknown {
  return (ci[from] as Record<string, unknown>)[key];
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function int(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

@Injectable()
export class ConnectivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clickhouse: ClickHouseService,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async connectivity(tenantId: string): Promise<ConnectivityView> {
    const rows = await this.prisma.client.ci.findMany({ where: { tenantId, type: { in: ['site', 'site_link'] }, validTo: null }, select: { id: true }, orderBy: { name: 'asc' } });
    const order = new Map(rows.map((r, i) => [r.id, i]));
    const cis = (await this.cis.findByIds(tenantId, rows.map((r) => r.id))).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const linksCi = cis.filter((c) => c.type === 'site_link');
    const latest = await this.latest(tenantId, linksCi.map((l) => l.id));
    const intervalMs = this.env.LINK_PROBE_INTERVAL_MS === 0 ? READINESS.evaluateMs : this.env.LINK_PROBE_INTERVAL_MS;
    const now = Date.now();
    const healthy = new Set<string>();
    const links: ConnectivityLinkView[] = linksCi.map((ci) => {
      const s: Latest = latest.get(ci.id) ?? {};
      const snapshot: LinkSnapshot = {
        ciId: ci.id,
        name: ci.displayName,
        fromSite: text(attr(ci, CONNECTIVITY_ATTRIBUTES.fromSiteRef, 'identity')),
        toSite: text(attr(ci, CONNECTIVITY_ATTRIBUTES.toSiteRef, 'identity')),
        replication: attr(ci, CONNECTIVITY_ATTRIBUTES.replication) === true,
        diversePaths: int(attr(ci, CONNECTIVITY_ATTRIBUTES.diversePaths)) ?? 1,
        slaLatencyMs: int(attr(ci, CONNECTIVITY_ATTRIBUTES.slaLatencyMs)),
        probed: text(attr(ci, CONNECTIVITY_ATTRIBUTES.probeTarget)) !== null,
        reachable: s[LINK_METRICS.reachable] ?? null,
        latencyMs: s[LINK_METRICS.latencyMs] ?? null,
        lossPercent: s[LINK_METRICS.lossPercent] ?? null,
      };
      if (linkHealth(snapshot, now, intervalMs) === 'healthy') healthy.add(ci.id);
      return {
        ci,
        fromSite: snapshot.fromSite,
        toSite: snapshot.toSite,
        kind: text(attr(ci, 'kind')),
        provider: text(attr(ci, 'provider')),
        role: text(attr(ci, 'role')),
        replication: snapshot.replication,
        diversePaths: snapshot.diversePaths,
        probeTarget: text(attr(ci, CONNECTIVITY_ATTRIBUTES.probeTarget)),
        reachable: snapshot.reachable === null ? null : snapshot.reachable.value >= 1,
        latencyMs: snapshot.latencyMs?.value ?? null,
        lossPercent: snapshot.lossPercent?.value ?? null,
        probedAt: snapshot.reachable === null ? null : new Date(snapshot.reachable.at).toISOString(),
        slaLatencyMs: snapshot.slaLatencyMs,
      };
    });
    const sites: ConnectivitySiteView[] = cis
      .filter((c) => c.type === 'site')
      .map((ci) => {
        const code = text(attr(ci, 'code', 'identity')) ?? ci.name;
        const role = text(attr(ci, CONNECTIVITY_ATTRIBUTES.drRole));
        return {
          ci,
          code,
          drRole: role !== null && DR_ROLES.has(role) ? role : 'none',
          criticality: int(attr(ci, CONNECTIVITY_ATTRIBUTES.criticality)),
          healthyPaths: links.filter((l) => healthy.has(l.ci.id) && (l.fromSite === code || l.toSite === code)).reduce((n, l) => n + Math.max(1, l.diversePaths), 0),
        };
      });
    const findings = await this.prisma.client.readinessFinding.findMany({
      where: { tenantId, OR: [{ state: 'open' }, { clearedAt: { gte: new Date(now - READINESS.clearedListedMs) } }] },
      orderBy: [{ state: 'desc' }, { openedAt: 'desc' }],
      take: READINESS.findingsListLimit,
    });
    return {
      sites,
      links,
      findings: findings.map((f) => ({ id: f.id, rule: f.rule, subjectCiId: f.subjectCiId, detail: f.detail, state: f.state, openedAt: isoOf(f.openedAt), clearedAt: toIso(f.clearedAt), incidentId: f.incidentId })),
      probeIntervalSeconds: Math.round(this.env.LINK_PROBE_INTERVAL_MS / TIME.msPerSecond),
    };
  }

  private async latest(tenantId: string, ids: readonly string[]): Promise<Map<string, Latest>> {
    const out = new Map<string, Latest>();
    if (ids.length === 0) return out;
    // `ci`, not `ci_id`: ClickHouse applies SELECT aliases in WHERE, so a string alias would break the UUID filter.
    const rows = await this.clickhouse.query<LatestRow>(
      'connectivity_latest',
      'SELECT toString(ci_id) AS ci, metric, argMax(value, ts) AS v, toUnixTimestamp64Milli(max(ts)) AS ms FROM ' +
        this.clickhouse.database +
        '.metrics_latest WHERE tenant_id = {tenantId:UUID} AND ci_id IN ({ids:Array(UUID)}) AND metric IN ({metrics:Array(String)}) GROUP BY ci_id, metric',
      { tenantId, ids: [...ids], metrics: [...LINK_METRIC_NAMES] },
    );
    for (const r of rows) {
      const entry = out.get(r.ci) ?? {};
      entry[r.metric] = { value: Number(r.v), at: Number(r.ms) };
      out.set(r.ci, entry);
    }
    return out;
  }
}
