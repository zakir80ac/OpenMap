// REQ-AI-003 (ADR-053) — anomaly rules over discovery and health events. The service reads each rule's facts from the
// stores, runs the pure rules (@openmap/assistant) and keeps one finding per rule and subject in anomaly_findings:
// - ip_conflict: the current uses_ip claims on addresses with more than one claimant (Postgres);
// - unmanaged_device_in_datacenter: unknown, unlabelled devices and the site they are located in (Postgres);
// - flapping_service: the business services' health changes over ANOMALY.flapLookbackDays (ClickHouse).
// A finding stays open while its rule holds, is refreshed with the latest facts, and clears when the rule stops. A sweep
// runs every ANOMALY_INTERVAL_MS for every tenant, and detectAnomalies runs one on demand. explainAnomaly asks the
// local model to explain a finding from its facts only, in the locales it writes well (ASSISTANT_PROSE_LOCALES, as
// ADR-028 decided for answers); elsewhere the explanation is the catalogue's template filled with the facts.
import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  anomalyExplanationMessages,
  createLlmClient,
  extractProse,
  flappingServices,
  ipConflicts,
  unmanagedInDatacenter,
  type HealthChange,
  type IpClaim,
  type LlmClient,
  type LocatedDevice,
} from '@openmap/assistant';
import { ANOMALY, TIME } from '@openmap/constants';
import type { AnomalyFact, AnomalyRule } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { translate, type MessageKey } from '@openmap/i18n';
import { withSpan } from '@openmap/telemetry';
import { ENV, type Env } from '../config/env.module.js';
import { ClickHouseService } from '../db/clickhouse.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';

export interface AnomalyFindingView {
  id: string;
  rule: AnomalyRule;
  subjectCiId: string;
  facts: AnomalyFact[];
  state: 'open' | 'cleared';
  detectedAt: Date;
  lastSeenAt: Date;
  clearedAt: Date | null;
  explanation: string | null;
  explanationLocale: string | null;
}

export interface AnomalyReportView {
  findings: AnomalyFindingView[];
  open: number;
  lastSweepAt: Date | null;
}

type Row = Prisma.AnomalyFindingGetPayload<object>;

function view(r: Row): AnomalyFindingView {
  return {
    id: r.id,
    rule: r.rule as AnomalyRule,
    subjectCiId: r.subjectCiId,
    facts: r.facts as unknown as AnomalyFact[],
    state: r.state === 'open' ? 'open' : 'cleared',
    detectedAt: r.detectedAt,
    lastSeenAt: r.lastSeenAt,
    clearedAt: r.clearedAt,
    explanation: r.explanation,
    explanationLocale: r.explanationLocale,
  };
}

/** The deterministic explanation of each rule, for the locales the model does not write (ADR-028). */
const EXPLAIN_TEMPLATE = {
  ip_conflict: 'anomaly.explainTemplate.ip_conflict',
  unmanaged_device_in_datacenter: 'anomaly.explainTemplate.unmanaged_device_in_datacenter',
  flapping_service: 'anomaly.explainTemplate.flapping_service',
} as const satisfies Record<AnomalyRule, MessageKey>;

interface HealthRow {
  svc: string;
  ms: string | number;
  health: string;
}

@Injectable()
export class AnomalyService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AnomalyService.name);
  private readonly llm: LlmClient;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private readonly lastSweep = new Map<string, Date>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clickhouse: ClickHouseService,
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.llm = createLlmClient(env);
  }

  onApplicationBootstrap(): void {
    const every = this.env.ANOMALY_INTERVAL_MS;
    if (every === 0) return;
    this.timer = setInterval(() => void this.sweepAll(), every);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Every tenant in turn; a sweep still running when the next tick comes is not doubled. */
  async sweepAll(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const t of await this.prisma.client.tenant.findMany({ select: { id: true } })) {
        try {
          await this.detect(t.id);
        } catch (err) {
          this.logger.warn('anomaly sweep failed for tenant ' + t.id + ': ' + (err instanceof Error ? err.message : String(err)));
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** Runs every rule for the tenant and reconciles its findings; returns the open findings' count. */
  async detect(tenantId: string, now: Date = new Date()): Promise<number> {
    return withSpan(TRACER_NAME, 'anomaly.detect', { 'openmap.tenant': tenantId }, async () => {
      const [claims, devices, changes] = await Promise.all([this.claims(tenantId), this.devices(tenantId), this.healthChanges(tenantId, now)]);
      const hits = [...ipConflicts(claims), ...unmanagedInDatacenter(devices), ...flappingServices(changes)];
      const db = this.prisma.client;
      const existing = await db.anomalyFinding.findMany({ where: { tenantId } });
      const key = (rule: string, subject: string): string => rule + '|' + subject;
      const byKey = new Map(existing.map((f) => [key(f.rule, f.subjectCiId), f]));
      const seen = new Set<string>();
      for (const hit of hits) {
        const k = key(hit.rule, hit.subjectCiId);
        seen.add(k);
        const before = byKey.get(k);
        const facts = hit.facts as unknown as Prisma.InputJsonValue;
        if (before === undefined) {
          await db.anomalyFinding.create({ data: { tenantId, rule: hit.rule, subjectCiId: hit.subjectCiId, facts, state: 'open', detectedAt: now, lastSeenAt: now } });
          this.metrics.anomalies.inc({ rule: hit.rule, outcome: 'opened' });
        } else if (before.state !== 'open') {
          await db.anomalyFinding.update({ where: { id: before.id }, data: { facts, state: 'open', detectedAt: now, lastSeenAt: now, clearedAt: null, explanation: null, explanationLocale: null, explainedAt: null } });
          this.metrics.anomalies.inc({ rule: hit.rule, outcome: 'opened' });
        } else {
          const changed = JSON.stringify(before.facts) !== JSON.stringify(hit.facts);
          await db.anomalyFinding.update({ where: { id: before.id }, data: { facts, lastSeenAt: now, ...(changed ? { explanation: null, explanationLocale: null, explainedAt: null } : {}) } });
        }
      }
      for (const f of existing)
        if (f.state === 'open' && !seen.has(key(f.rule, f.subjectCiId))) {
          await db.anomalyFinding.update({ where: { id: f.id }, data: { state: 'cleared', clearedAt: now } });
          this.metrics.anomalies.inc({ rule: f.rule, outcome: 'cleared' });
        }
      this.lastSweep.set(tenantId, now);
      return hits.length;
    });
  }

  /** Open findings, then those cleared within ANOMALY.clearedListedMs, newest first. */
  async report(tenantId: string, now: Date = new Date()): Promise<AnomalyReportView> {
    const db = this.prisma.client;
    const rows = await db.anomalyFinding.findMany({
      where: { tenantId, OR: [{ state: 'open' }, { clearedAt: { gte: new Date(now.getTime() - ANOMALY.clearedListedMs) } }] },
      orderBy: [{ state: 'desc' }, { detectedAt: 'desc' }],
      take: ANOMALY.findingsListLimit,
    });
    return { findings: rows.map(view), open: rows.filter((r) => r.state === 'open').length, lastSweepAt: this.lastSweep.get(tenantId) ?? null };
  }

  /** The model's explanation of a finding, from its facts only, kept on the finding until its facts change. */
  async explain(tenantId: string, id: string, locale: 'en' | 'ar'): Promise<AnomalyFindingView> {
    const db = this.prisma.client;
    const f = await db.anomalyFinding.findFirst({ where: { id, tenantId } });
    if (f === null) throw new NotFoundException('anomaly finding ' + id + ' not found');
    if (f.explanation !== null && f.explanationLocale === locale) return view(f);
    const facts = f.facts as unknown as AnomalyFact[];
    const proseLocales = this.env.ASSISTANT_PROSE_LOCALES.split(',').map((l) => l.trim());
    if (!proseLocales.includes(locale)) {
      const params = Object.fromEntries(facts.map((x) => [x.key, x.value]));
      const done = await db.anomalyFinding.update({ where: { id }, data: { explanation: translate(locale, EXPLAIN_TEMPLATE[f.rule as AnomalyRule], params), explanationLocale: locale, explainedAt: new Date() } });
      this.metrics.anomalies.inc({ rule: f.rule, outcome: 'explained' });
      return view(done);
    }
    let text: string;
    try {
      const reply = await this.llm.complete(anomalyExplanationMessages(f.rule as AnomalyRule, facts, locale));
      text = extractProse(reply.text);
    } catch (err) {
      this.metrics.anomalies.inc({ rule: f.rule, outcome: 'explain_failed' });
      throw new ServiceUnavailableException('the model could not explain the finding: ' + (err instanceof Error ? err.message : String(err)));
    }
    if (text === '') throw new ServiceUnavailableException('the model returned no explanation');
    const done = await db.anomalyFinding.update({ where: { id }, data: { explanation: text, explanationLocale: locale, explainedAt: new Date() } });
    this.metrics.anomalies.inc({ rule: f.rule, outcome: 'explained' });
    return view(done);
  }

  /** Current uses_ip claims on the addresses that have more than one claimant. */
  private claims(tenantId: string): Promise<IpClaim[]> {
    return this.prisma.client.$queryRaw<IpClaim[]>(Prisma.sql`
      WITH shared AS (
        SELECT r."toCiId" AS ip FROM relationships r JOIN cis c ON c.id = r."fromCiId" AND c."validTo" IS NULL
        WHERE r."tenantId" = ${tenantId}::uuid AND r.type = 'uses_ip' AND r."validTo" IS NULL
        GROUP BY r."toCiId" HAVING count(DISTINCT r."fromCiId") > 1
      )
      SELECT ip.id::text AS "ipCiId", COALESCE(ip.identity->>'address', ip.name) AS address, c.id::text AS "claimantId",
        c."displayName" AS "claimantName", c.type::text AS "claimantType"
      FROM shared s
      JOIN relationships r ON r."toCiId" = s.ip AND r."tenantId" = ${tenantId}::uuid AND r.type = 'uses_ip' AND r."validTo" IS NULL
      JOIN cis ip ON ip.id = s.ip AND ip."validTo" IS NULL
      JOIN cis c ON c.id = r."fromCiId" AND c."validTo" IS NULL`);
  }

  /** Unknown, unlabelled devices with the site they are located in, walked up located_in. */
  private devices(tenantId: string): Promise<LocatedDevice[]> {
    return this.prisma.client.$queryRaw<LocatedDevice[]>(Prisma.sql`
      WITH RECURSIVE up(device, ci, depth) AS (
        SELECT d.id, d.id, 0 FROM cis d
        WHERE d."tenantId" = ${tenantId}::uuid AND d.type = 'unknown' AND d."validTo" IS NULL AND d."userLabel" IS NULL
        UNION ALL
        SELECT up.device, r."toCiId", up.depth + 1 FROM up
        JOIN relationships r ON r."fromCiId" = up.ci AND r."tenantId" = ${tenantId}::uuid AND r.type = 'located_in' AND r."validTo" IS NULL
        WHERE up.depth < ${ANOMALY.locationHops}
      ),
      sited AS (
        SELECT DISTINCT ON (up.device) up.device, s."displayName" AS site_name, s.attributes->>'kind' AS site_kind
        FROM up JOIN cis s ON s.id = up.ci AND s.type = 'site' AND s."validTo" IS NULL
        ORDER BY up.device, up.depth
      )
      SELECT d.id::text AS "ciId", d."displayName" AS name, sited.site_name AS "siteName", sited.site_kind AS "siteKind",
        d.identity->>'address' AS address, d.attributes->>'vendorFromOui' AS vendor, d.attributes->>'firstSeen' AS "firstSeen"
      FROM cis d LEFT JOIN sited ON sited.device = d.id
      WHERE d."tenantId" = ${tenantId}::uuid AND d.type = 'unknown' AND d."validTo" IS NULL AND d."userLabel" IS NULL`);
  }

  /** The business services' health changes over ANOMALY.flapLookbackDays, with their names. */
  private async healthChanges(tenantId: string, now: Date): Promise<HealthChange[]> {
    const rows = await this.clickhouse.query<HealthRow>(
      'anomaly_health_changes',
      'SELECT toString(service_ci_id) AS svc, toUnixTimestamp64Milli(ts) AS ms, health FROM ' +
        this.clickhouse.database +
        '.service_health_history WHERE tenant_id = {tenantId:UUID} AND ts >= fromUnixTimestamp64Milli({since:Int64}) ORDER BY svc, ts',
      { tenantId, since: now.getTime() - ANOMALY.flapLookbackDays * TIME.msPerDay },
    );
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((r) => r.svc))];
    const names = new Map((await this.prisma.client.ci.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, displayName: true } })).map((c) => [c.id, c.displayName]));
    return rows.map((r) => ({ serviceId: r.svc, serviceName: names.get(r.svc) ?? r.svc, at: Number(r.ms), health: r.health }));
  }
}

