// REQ-SEC-012 (ADR-070) — compliance posture per framework. An evaluation gathers the stored facts, runs every check
// of the catalogue (packages/contracts/src/compliance.ts) over them, stores each decision with the facts that decided
// it, and keeps the per-framework posture (pass rate, control results, high-risk CIs) and the CVE risk as the run's
// summary. Reads serve the latest run: the posture from its summary, a control's findings from its results.
import { BadRequestException, Injectable } from '@nestjs/common';
import { COMPLIANCE } from '@openmap/constants';
import {
  COMPLIANCE_CATALOGUE_VERSION,
  COMPLIANCE_CHECKS,
  COMPLIANCE_FRAMEWORKS,
  COMPLIANCE_REASONS,
  COMPLIANCE_RESULTS,
  checkBucketPublic,
  checkCertificate,
  checkCveExposure,
  checkDatabaseBackup,
  checkFirewall,
  checkHardware,
  checkPatch,
  checkPlatformBackup,
  checkRelease,
  checkShareEncryption,
  checkStorageEncryption,
  checkTls,
  complianceFramework,
  compliancePosture,
  cveRisk,
  isHighRiskCve,
  type ComplianceCheck,
  type ComplianceFactValue,
  type ComplianceFramework,
  type ComplianceOutcome,
  type ComplianceReason,
  type ComplianceResult,
  type ComplianceTally,
  type CveRisk,
  type FrameworkPosture,
  type LifecycleState,
} from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { Counter, Histogram } from 'prom-client';
import { z } from 'zod';
import { BackupsService } from '../backups/backups.service.js';
import { CertificatesService } from '../certificates/certificates.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';
import {
  ComplianceFactsRepository,
  type BucketFact,
  type DatabaseFact,
  type ExposureFact,
  type FirewallFact,
  type HardwareFact,
  type OsFact,
  type ShareFact,
  type StorageFact,
  type TlsFact,
} from './compliance.facts.js';

export const COMPLIANCE_EVALUATIONS_METRIC = 'openmap_compliance_evaluations_total';
export const COMPLIANCE_DURATION_METRIC = 'openmap_compliance_evaluation_seconds';
export const COMPLIANCE_RESULTS_METRIC = 'openmap_compliance_results_total';

export interface ReleaseFact {
  ciId: string;
  state: LifecycleState;
  label: string;
  endOfSupport: string | null;
}

export interface CertificateFact {
  ciId: string;
  subject: string;
  notAfter: string | null;
  daysLeft: number | null;
  expired: boolean;
  weaknesses: string[];
}

export interface PlatformBackupFact {
  configured: boolean;
  stale: boolean;
  lastCompleteAt: string | null;
  newestEncrypted: boolean | null;
  staleAfterHours: number;
}

/** Everything one evaluation reads, gathered before any check runs. */
export interface ComplianceFacts {
  exposure: ExposureFact[];
  operatingSystems: OsFact[];
  releases: ReleaseFact[];
  hardware: HardwareFact[];
  certificates: CertificateFact[];
  tls: TlsFact[];
  storage: StorageFact[];
  shares: ShareFact[];
  buckets: BucketFact[];
  databases: DatabaseFact[];
  firewalls: FirewallFact[];
  platformBackup: PlatformBackupFact;
}

export interface Assessment {
  outcomes: ComplianceOutcome[];
  /** CIs with a high or critical CVE. */
  exposed: Set<string>;
  /** Subject → the CI its risk belongs to (an operating system → its host). */
  anchors: Map<string, string>;
  frameworks: FrameworkPosture[];
  cveRisk: CveRisk;
}

/** Runs every check over the facts and computes the posture; pure, so the unit tests drive it directly. */
export function assess(facts: ComplianceFacts, now: Date): Assessment {
  const outcomes: ComplianceOutcome[] = [];
  for (const e of facts.exposure) outcomes.push(...checkCveExposure(e.ciId, e.installed, e.cves));
  for (const r of facts.releases) outcomes.push(checkRelease(r.ciId, r));
  for (const os of facts.operatingSystems) outcomes.push(checkPatch(os.ciId, os.lastPatchedAt, now));
  for (const h of facts.hardware) outcomes.push(checkHardware(h.ciId, h.endOfSupport, h.source, now));
  for (const c of facts.certificates) outcomes.push(...checkCertificate(c.ciId, c));
  for (const t of facts.tls) outcomes.push(checkTls(t.ciId, t.tlsVersion, t.endpoint));
  for (const s of facts.storage) outcomes.push(checkStorageEncryption(s.ciId, s.attributes));
  for (const s of facts.shares) outcomes.push(checkShareEncryption(s.ciId, s.protocol, s.options));
  for (const b of facts.buckets) {
    const o = checkBucketPublic(b.ciId, b.publicAccessBlocked);
    if (o !== null) outcomes.push(o);
  }
  for (const d of facts.databases) outcomes.push(checkDatabaseBackup(d.ciId, d.lastBackupAt, now));
  for (const f of facts.firewalls) outcomes.push(checkFirewall(f.ciId, f.rules, f.permissive, f.truncated));
  outcomes.push(checkPlatformBackup(facts.platformBackup));

  const exposed = new Set(facts.exposure.filter((e) => e.cves.some(isHighRiskCve)).map((e) => e.ciId));
  const anchors = new Map<string, string>();
  for (const os of facts.operatingSystems) if (os.hostId !== null) anchors.set(os.ciId, os.hostId);
  return {
    outcomes,
    exposed,
    anchors,
    frameworks: compliancePosture(outcomes, exposed, anchors),
    cveRisk: cveRisk(new Map(facts.exposure.map((e) => [e.ciId, e.cves]))),
  };
}

/** Whether a failing outcome sits on a CI (or the host of an OS) that carries a high or critical CVE. */
export function isHighRiskOutcome(o: ComplianceOutcome, exposed: ReadonlySet<string>, anchors: ReadonlyMap<string, string>): boolean {
  return o.result === 'fail' && o.ciId !== null && exposed.has(anchors.get(o.ciId) ?? o.ciId);
}

const tallySchema = z.object({ passed: z.number().int(), failed: z.number().int(), notApplicable: z.number().int() });
const summarySchema = z.object({
  frameworks: z.array(
    z.object({
      framework: z.enum(COMPLIANCE_FRAMEWORKS),
      edition: z.string(),
      passRate: z.number().nullable(),
      evaluations: tallySchema,
      controlsPassed: z.number().int(),
      controlsFailed: z.number().int(),
      controlsNotApplicable: z.number().int(),
      controls: z.array(
        z.object({ controlId: z.string(), checks: z.array(z.enum(COMPLIANCE_CHECKS)), result: z.enum(COMPLIANCE_RESULTS), tally: tallySchema }),
      ),
      highRiskCis: z.number().int(),
    }),
  ),
  cveRisk: z.object({ critical: z.number().int(), high: z.number().int(), exploited: z.number().int(), exposedCis: z.number().int() }),
});

export interface ComplianceRunView {
  id: string;
  catalogueVersion: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  triggeredBy: string;
}

export interface CompliancePostureView {
  run: ComplianceRunView | null;
  frameworks: FrameworkPosture[];
  cveRisk: CveRisk | null;
}

export interface ComplianceFactView {
  key: string;
  value: string | null;
}

export interface ComplianceFindingView {
  check: ComplianceCheck;
  result: ComplianceResult;
  reason: ComplianceReason;
  ciId: string | null;
  facts: ComplianceFactView[];
  highRisk: boolean;
}

export interface ComplianceControlView {
  framework: ComplianceFramework;
  controlId: string;
  checks: ComplianceCheck[];
  result: ComplianceResult;
  tally: ComplianceTally;
  findings: ComplianceFindingView[];
  truncated: boolean;
}

interface ResultRow {
  check: string;
  ciId: string | null;
  result: string;
  reason: string;
  facts: Prisma.JsonValue;
  highRisk: boolean;
}

function factValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function toFinding(row: ResultRow): ComplianceFindingView {
  const facts = row.facts !== null && typeof row.facts === 'object' && !Array.isArray(row.facts) ? row.facts : {};
  return {
    check: z.enum(COMPLIANCE_CHECKS).parse(row.check),
    result: z.enum(COMPLIANCE_RESULTS).parse(row.result),
    reason: z.enum(COMPLIANCE_REASONS).parse(row.reason),
    ciId: row.ciId,
    facts: Object.entries(facts).map(([key, value]) => ({ key, value: factValue(value) })),
    highRisk: row.highRisk,
  };
}

@Injectable()
export class ComplianceService {
  private readonly evaluations: Counter;
  private readonly duration: Histogram;
  private readonly results: Counter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly facts: ComplianceFactsRepository,
    private readonly lifecycle: LifecycleService,
    private readonly certificates: CertificatesService,
    private readonly backups: BackupsService,
    metrics: MetricsService,
  ) {
    this.evaluations = new Counter({
      name: COMPLIANCE_EVALUATIONS_METRIC,
      help: 'Compliance evaluations run, by outcome (ok, failed)',
      labelNames: ['outcome'],
      registers: [metrics.registry],
    });
    this.duration = new Histogram({
      name: COMPLIANCE_DURATION_METRIC,
      help: 'Duration of a compliance evaluation: gathering the facts, running the checks and storing the results',
      registers: [metrics.registry],
    });
    this.results = new Counter({
      name: COMPLIANCE_RESULTS_METRIC,
      help: 'Compliance check decisions stored, by check and result',
      labelNames: ['check', 'result'],
      registers: [metrics.registry],
    });
  }

  /**
   * Reads every fact family the checks use, one after another: an evaluation is a background read of the whole
   * estate and must not take the pool's every connection from the interactive queries running beside it.
   */
  async gather(tenantId: string, now: Date): Promise<ComplianceFacts> {
    const exposure = await this.facts.exposure(tenantId);
    const operatingSystems = await this.facts.operatingSystems(tenantId);
    const releasePage = await this.lifecycle.releases(tenantId, { kind: null, state: null, text: null }, now);
    const hardware = await this.facts.hardware(tenantId);
    const certificates = await this.certificates.certificates(tenantId, { text: null, expiringWithinDays: null, expired: null, selfSigned: null, weak: null, includeAuthorities: false });
    const tls = await this.facts.tlsListeners(tenantId);
    const storage = await this.facts.storage(tenantId);
    const shares = await this.facts.shares(tenantId);
    const buckets = await this.facts.buckets(tenantId);
    const databases = await this.facts.databases(tenantId);
    const firewalls = await this.facts.firewalls(tenantId);
    const backups = await this.backups.list(now);
    const releases: ReleaseFact[] = releasePage.rows.flatMap((row) =>
      row.ciIds.map((ciId) => ({ ciId, state: row.state, label: row.label, endOfSupport: row.entry?.endOfSupport ?? null })),
    );
    const newest = backups.sets.find((s) => s.status === 'complete' && s.completedAt === backups.lastCompleteAt);
    return {
      exposure,
      operatingSystems,
      releases,
      hardware,
      certificates: certificates.map((c) => ({ ciId: c.ci.id, subject: c.subject, notAfter: c.notAfter, daysLeft: c.daysLeft, expired: c.expired, weaknesses: c.weaknesses })),
      tls,
      storage,
      shares,
      buckets,
      databases,
      firewalls,
      platformBackup: {
        configured: backups.configured,
        stale: backups.stale,
        lastCompleteAt: backups.lastCompleteAt,
        newestEncrypted: newest?.encrypted ?? null,
        staleAfterHours: backups.staleAfterHours,
      },
    };
  }

  /** Runs and stores a new evaluation of the tenant, then returns its posture. */
  async evaluate(tenantId: string, triggeredBy: string): Promise<CompliancePostureView> {
    return withSpan(TRACER_NAME, 'compliance.evaluate', { 'openmap.tenant': tenantId }, async (span) => {
      const stop = this.duration.startTimer();
      const startedAt = new Date();
      try {
        const facts = await this.gather(tenantId, startedAt);
        const assessment = assess(facts, startedAt);
        const runId = await this.persist(tenantId, triggeredBy, startedAt, assessment);
        span.setAttribute('openmap.compliance.results', assessment.outcomes.length);
        for (const o of assessment.outcomes) this.results.inc({ check: o.check, result: o.result });
        this.evaluations.inc({ outcome: 'ok' });
        return await this.postureOf(tenantId, runId);
      } catch (error) {
        this.evaluations.inc({ outcome: 'failed' });
        throw error;
      } finally {
        stop();
      }
    });
  }

  private async persist(tenantId: string, triggeredBy: string, startedAt: Date, a: Assessment): Promise<string> {
    const finishedAt = new Date();
    const summary = { frameworks: a.frameworks, cveRisk: a.cveRisk };
    return this.prisma.client.$transaction(
      async (tx) => {
        const run = await tx.complianceRun.create({
          data: {
            tenantId,
            catalogueVersion: COMPLIANCE_CATALOGUE_VERSION,
            startedAt,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            triggeredBy,
            summary: summary as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        for (let start = 0; start < a.outcomes.length; start += COMPLIANCE.insertBatch) {
          const batch = a.outcomes.slice(start, start + COMPLIANCE.insertBatch);
          const checks = batch.map((o) => o.check);
          const cis = batch.map((o) => o.ciId);
          const results = batch.map((o) => o.result);
          const reasons = batch.map((o) => o.reason);
          const facts = batch.map((o) => JSON.stringify(o.facts satisfies Record<string, ComplianceFactValue>));
          const high = batch.map((o) => isHighRiskOutcome(o, a.exposed, a.anchors));
          const seq = batch.map((_, i) => start + i);
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO compliance_results ("runId", "tenantId", "check", "ciId", "result", "reason", "facts", "highRisk", "seq")
            SELECT ${run.id}::uuid, ${tenantId}::uuid, t.c, t.ci::uuid, t.r, t.re, t.f::jsonb, t.h, t.s
            FROM unnest(${checks}::text[], ${cis}::text[], ${results}::text[], ${reasons}::text[], ${facts}::text[], ${high}::bool[], ${seq}::int[])
              AS t(c, ci, r, re, f, h, s)`);
        }
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM compliance_runs WHERE "tenantId" = ${tenantId}::uuid AND id NOT IN (
            SELECT id FROM compliance_runs WHERE "tenantId" = ${tenantId}::uuid ORDER BY "startedAt" DESC LIMIT ${COMPLIANCE.keepRuns})`);
        return run.id;
      },
      { timeout: COMPLIANCE.persistTimeoutMs, maxWait: COMPLIANCE.persistTimeoutMs },
    );
  }

  private async latestRun(tenantId: string) {
    return this.prisma.client.complianceRun.findFirst({ where: { tenantId }, orderBy: { startedAt: 'desc' } });
  }

  private async postureOf(tenantId: string, runId: string | null): Promise<CompliancePostureView> {
    const run =
      runId === null ? await this.latestRun(tenantId) : await this.prisma.client.complianceRun.findFirst({ where: { tenantId, id: runId } });
    if (run === null) return { run: null, frameworks: [], cveRisk: null };
    const summary = summarySchema.parse(run.summary);
    return {
      run: {
        id: run.id,
        catalogueVersion: run.catalogueVersion,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        triggeredBy: run.triggeredBy,
      },
      frameworks: summary.frameworks,
      cveRisk: summary.cveRisk,
    };
  }

  /** The latest evaluation's posture; no run yet means no posture, never a made-up one. */
  async posture(tenantId: string): Promise<CompliancePostureView> {
    return withSpan(TRACER_NAME, 'compliance.posture', { 'openmap.tenant': tenantId }, () => this.postureOf(tenantId, null));
  }

  /** One control of the latest evaluation: its tally and the decisions with one result, high-risk CIs first. */
  async control(tenantId: string, framework: ComplianceFramework, controlId: string, result: ComplianceResult, first: number): Promise<ComplianceControlView> {
    return withSpan(TRACER_NAME, 'compliance.control', { 'openmap.tenant': tenantId, 'openmap.compliance.framework': framework }, async () => {
      const control = complianceFramework(framework).controls.find((c) => c.id === controlId);
      if (control === undefined) throw new BadRequestException('unknown control ' + controlId + ' in ' + framework);
      const checks = [...control.checks];
      const run = await this.latestRun(tenantId);
      if (run === null) return { framework, controlId, checks, result: 'not_applicable', tally: { passed: 0, failed: 0, notApplicable: 0 }, findings: [], truncated: false };
      const summary = summarySchema.parse(run.summary);
      const posture = summary.frameworks.find((f) => f.framework === framework)?.controls.find((c) => c.controlId === controlId);
      const rows = await this.prisma.client.$queryRaw<ResultRow[]>(Prisma.sql`
        SELECT "check", "ciId"::text AS "ciId", "result", "reason", "facts", "highRisk"
        FROM compliance_results
        WHERE "runId" = ${run.id}::uuid AND "check" = ANY(${checks}::text[]) AND "result" = ${result}
        ORDER BY "highRisk" DESC, "seq"
        LIMIT ${first + 1}`);
      return {
        framework,
        controlId,
        checks,
        result: posture?.result ?? 'not_applicable',
        tally: posture?.tally ?? { passed: 0, failed: 0, notApplicable: 0 },
        findings: rows.slice(0, first).map(toFinding),
        truncated: rows.length > first,
      };
    });
  }
}
