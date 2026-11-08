// REQ-BSM-007 (ADR-025) — the Sites screen's read model:
// - the tenant's site and site_link CIs with their DR role, criticality and replication flag;
// - each link's latest probe (ClickHouse metrics_latest) and the health the BSM engine derives from it, using the
//   same linkHealth;
// - the healthy paths each site has;
// - the readiness findings with their incidents.
// REQ-UI-026: each site's facility card (kind, tier, power capacity, design and measured PUE, racks in its facility
// tree, open alerts) and each link's traffic against its committed bandwidth and its redundancy state.
import { Inject, Injectable } from '@nestjs/common';
import { linkHealth, linkRedundancy, type LinkSnapshot } from '@openmap/bsm-engine';
import { BSM, READINESS, TIME } from '@openmap/constants';
import {
  CONNECTIVITY_ATTRIBUTES,
  LINK_METRICS,
  LINK_METRIC_NAMES,
  LINK_TRAFFIC_METRICS,
  SITE_DR_ROLES,
  SITE_FACILITY_ATTRIBUTES,
  SITE_FACILITY_CI_TYPES,
  SITE_FACILITY_METRICS,
  type LinkRedundancy,
} from '@openmap/contracts';
import { Prisma } from '@openmap/db';
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
  kind: string | null;
  tier: number | null;
  powerCapacityKw: number | null;
  designPue: number | null;
  /** Latest measured PUE and when it was taken; null when the site reports none. */
  pue: number | null;
  pueAt: string | null;
  /** Racks in the site's facility tree (building, room, row, rack). */
  racks: number;
  /** Open readiness findings on the site or its links, plus unresolved incidents whose root cause is in the site. */
  openAlerts: number;
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
  /** Committed bandwidth; null when the link CI records none. */
  capacityMbps: number | null;
  /** Latest measured traffic; null when the link reports none. */
  throughputMbps: number | null;
  /** Traffic as a share of the committed bandwidth; null without both. */
  utilisationPercent: number | null;
  redundancy: LinkRedundancy;
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

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

interface CountRow {
  site: string;
  n: bigint | number;
}

interface IncidentSiteRow {
  incident: string;
  site: string;
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
    const sitesCi = cis.filter((c) => c.type === 'site');
    const intervalMs = this.env.LINK_PROBE_INTERVAL_MS === 0 ? READINESS.evaluateMs : this.env.LINK_PROBE_INTERVAL_MS;
    const now = Date.now();
    const [latest, racks, incidentSites, findings] = await Promise.all([
      this.latest(tenantId, cis.map((c) => c.id)),
      this.racksBySite(tenantId),
      this.unresolvedIncidentSites(tenantId),
      this.prisma.client.readinessFinding.findMany({
        where: { tenantId, OR: [{ state: 'open' }, { clearedAt: { gte: new Date(now - READINESS.clearedListedMs) } }] },
        orderBy: [{ state: 'desc' }, { openedAt: 'desc' }],
        take: READINESS.findingsListLimit,
      }),
    ]);
    const healthy = new Set<string>();
    const linkRows = linksCi.map((ci) => {
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
      const health = linkHealth(snapshot, now, intervalMs);
      if (health === 'healthy') healthy.add(ci.id);
      return { ci, snapshot, health, traffic: s[LINK_TRAFFIC_METRICS.throughputGbps] ?? null };
    });
    const redundancy = linkRedundancy(
      linkRows.map((l) => ({ ciId: l.ci.id, fromSite: l.snapshot.fromSite, toSite: l.snapshot.toSite, role: text(attr(l.ci, 'role')), diversePaths: l.snapshot.diversePaths, health: l.health })),
    );
    const links: ConnectivityLinkView[] = linkRows.map(({ ci, snapshot, traffic }) => {
      const capacityMbps = int(attr(ci, CONNECTIVITY_ATTRIBUTES.bandwidthMbps));
      const throughputMbps = traffic === null ? null : traffic.value * READINESS.megabitsPerGigabit;
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
        capacityMbps,
        throughputMbps,
        utilisationPercent: throughputMbps === null || capacityMbps === null || capacityMbps <= 0 ? null : (throughputMbps / capacityMbps) * BSM.percentScale,
        redundancy: redundancy.get(ci.id) ?? 'single_path',
      };
    });
    const openFindingSubjects = findings.filter((f) => f.state === 'open').map((f) => f.subjectCiId);
    const sites: ConnectivitySiteView[] = sitesCi.map((ci) => {
      const code = text(attr(ci, 'code', 'identity')) ?? ci.name;
      const role = text(attr(ci, CONNECTIVITY_ATTRIBUTES.drRole));
      const touching = links.filter((l) => l.fromSite === code || l.toSite === code);
      const subjects = new Set([ci.id, ...touching.map((l) => l.ci.id)]);
      const pue = (latest.get(ci.id) ?? {})[SITE_FACILITY_METRICS.pue] ?? null;
      // An incident counts once per site: on its root cause's site, or on the site of the link it names.
      const incidents = new Set(incidentSites.filter((r) => subjects.has(r.site)).map((r) => r.incident));
      return {
        ci,
        code,
        drRole: role !== null && DR_ROLES.has(role) ? role : 'none',
        criticality: int(attr(ci, CONNECTIVITY_ATTRIBUTES.criticality)),
        healthyPaths: touching.filter((l) => healthy.has(l.ci.id)).reduce((n, l) => n + Math.max(1, l.diversePaths), 0),
        kind: text(attr(ci, SITE_FACILITY_ATTRIBUTES.kind)),
        tier: int(attr(ci, SITE_FACILITY_ATTRIBUTES.tier)),
        powerCapacityKw: num(attr(ci, SITE_FACILITY_ATTRIBUTES.powerCapacityKw)),
        designPue: num(attr(ci, SITE_FACILITY_ATTRIBUTES.designPue)),
        pue: pue?.value ?? null,
        pueAt: pue === null ? null : new Date(pue.at).toISOString(),
        racks: racks.get(ci.id) ?? 0,
        openAlerts: openFindingSubjects.filter((s) => subjects.has(s)).length + incidents.size,
      };
    });
    return {
      sites,
      links,
      findings: findings.map((f) => ({ id: f.id, rule: f.rule, subjectCiId: f.subjectCiId, detail: f.detail, state: f.state, openedAt: isoOf(f.openedAt), clearedAt: toIso(f.clearedAt), incidentId: f.incidentId })),
      probeIntervalSeconds: Math.round(this.env.LINK_PROBE_INTERVAL_MS / TIME.msPerSecond),
    };
  }

  /** Racks per site CI: the site's facility tree (SITE_FACILITY_CI_TYPES) walked down its located_in edges. */
  private async racksBySite(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.client.$queryRaw<CountRow[]>(Prisma.sql`
      WITH RECURSIVE tree(site, ci, type, depth) AS (
        SELECT c.id, c.id, c.type::text, 0 FROM cis c
        WHERE c."tenantId" = ${tenantId}::uuid AND c.type = 'site' AND c."validTo" IS NULL
        UNION ALL
        SELECT tree.site, k.id, k.type::text, tree.depth + 1 FROM tree
        JOIN relationships r ON r."toCiId" = tree.ci AND r."tenantId" = ${tenantId}::uuid AND r.type = 'located_in' AND r."validTo" IS NULL
        JOIN cis k ON k.id = r."fromCiId" AND k."validTo" IS NULL AND k.type::text = ANY(${[...SITE_FACILITY_CI_TYPES]}::text[])
        WHERE tree.depth < ${SITE_FACILITY_CI_TYPES.length}
      )
      SELECT site::text AS site, count(DISTINCT ci) AS n FROM tree WHERE type = 'rack' GROUP BY site`);
    return new Map(rows.map((r) => [r.site, Number(r.n)]));
  }

  /**
   * The CI each unresolved incident belongs to on the Sites screen: the site its root cause is located in (walking up
   * located_in), or the root cause itself when that is a site or a link. Incidents are few, so the walk starts from
   * them, not from the sites.
   */
  private async unresolvedIncidentSites(tenantId: string): Promise<IncidentSiteRow[]> {
    return this.prisma.client.$queryRaw<IncidentSiteRow[]>(Prisma.sql`
      WITH RECURSIVE up(incident, ci, depth) AS (
        SELECT i.id, i."rootCauseCiId", 0 FROM incidents i
        WHERE i."tenantId" = ${tenantId}::uuid AND i."rootCauseCiId" IS NOT NULL
          AND i.state::text = ANY(${[...READINESS.alertIncidentStates]}::text[])
        UNION ALL
        SELECT up.incident, r."toCiId", up.depth + 1 FROM up
        JOIN relationships r ON r."fromCiId" = up.ci AND r."tenantId" = ${tenantId}::uuid AND r.type = 'located_in' AND r."validTo" IS NULL
        WHERE up.depth < ${READINESS.locationHops}
      )
      SELECT DISTINCT up.incident::text AS incident, up.ci::text AS site FROM up
      JOIN cis c ON c.id = up.ci AND c.type IN ('site', 'site_link')`);
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
      { tenantId, ids: [...ids], metrics: [...LINK_METRIC_NAMES, ...Object.values(LINK_TRAFFIC_METRICS), ...Object.values(SITE_FACILITY_METRICS)] },
    );
    for (const r of rows) {
      const entry = out.get(r.ci) ?? {};
      entry[r.metric] = { value: Number(r.v), at: Number(r.ms) };
      out.set(r.ci, entry);
    }
    return out;
  }
}
