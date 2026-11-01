// REQ-DISC-029 — discovery persistence: nodes, jobs, runs, manifests and sites. Interface plus Prisma
// implementation; runDiscovery persists the planner's CollectorJobs as discovery_jobs rows.
import { Injectable } from '@nestjs/common';
import { TIME } from '@openmap/constants';
import { collectorManifestSchema, type CollectorJob, type CollectorManifest } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { isoOf, toIso } from '../common/time.js';
import { asRecord } from '../common/validation.js';
import { PrismaService } from '../db/prisma.service.js';
import type { DiscoveryJobView, DiscoveryNodeView } from './discovery.types.js';

export const DISCOVERY_REPOSITORY = Symbol('DISCOVERY_REPOSITORY');

export interface SiteRef {
  id: string;
  ciId: string | null;
}

export interface JobRunStats {
  jobId: string;
  cisEmitted: number;
  errors: number;
}

export interface DiscoveryRepository {
  nodes(tenantId: string): Promise<DiscoveryNodeView[]>;
  node(tenantId: string, id: string): Promise<DiscoveryNodeView | null>;
  jobs(tenantId: string, status: string | null, first: number): Promise<DiscoveryJobView[]>;
  jobsBySweep(tenantId: string, sweepId: string): Promise<DiscoveryJobView[]>;
  latestSweepId(tenantId: string): Promise<string | null>;
  runStats(tenantId: string, jobIds: readonly string[]): Promise<JobRunStats[]>;
  manifests(): Promise<CollectorManifest[]>;
  /** Observed seconds per target per collector from past runs. */
  secondsPerTarget(tenantId: string): Promise<Record<string, number>>;
  sites(siteIds: readonly string[]): Promise<SiteRef[]>;
  sitesByCiIds(ciIds: readonly string[]): Promise<SiteRef[]>;
  createJobs(tx: Prisma.TransactionClient, jobs: readonly CollectorJob[]): Promise<void>;
}

type NodeRow = Prisma.DiscoveryNodeGetPayload<{
  include: { site: true; _count: { select: { jobs: { where: { status: 'started' } } } } };
}>;
type JobRow = Awaited<ReturnType<PrismaClient['discoveryJob']['findUniqueOrThrow']>>;

const NODE_INCLUDE = {
  site: true,
  _count: { select: { jobs: { where: { status: 'started' } } } },
} as const satisfies Prisma.DiscoveryNodeInclude;

function toNode(row: NodeRow): DiscoveryNodeView {
  return {
    id: row.id,
    siteId: row.siteId,
    siteCiId: row.site.ciId,
    status: row.status,
    lastHeartbeat: toIso(row.lastHeartbeatAt) ?? isoOf(row.createdAt),
    activeJobs: row._count.jobs,
    certificateExpiresAt: toIso(row.certificateExpiresAt) ?? isoOf(row.createdAt),
    collectorIds: row.collectorIds,
  };
}

export function sweepIdOf(options: Prisma.JsonValue): string | null {
  const v = asRecord(options)['sweepId'];
  return typeof v === 'string' ? v : null;
}

function toJob(row: JobRow, stats: JobRunStats | undefined): DiscoveryJobView {
  return {
    id: row.id,
    collectorId: row.collectorId,
    nodeId: row.nodeId,
    status: row.status,
    targets: Array.isArray(row.targets) ? row.targets.length : 0,
    scheduledAt: isoOf(row.scheduledAt),
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    cisEmitted: stats?.cisEmitted ?? 0,
    errors: stats?.errors ?? 0,
    sweepId: sweepIdOf(row.options),
  };
}

@Injectable()
export class PrismaDiscoveryRepository implements DiscoveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async nodes(tenantId: string): Promise<DiscoveryNodeView[]> {
    const rows = await this.prisma.client.discoveryNode.findMany({
      where: { tenantId },
      include: NODE_INCLUDE,
      orderBy: { id: 'asc' },
    });
    return rows.map(toNode);
  }

  async node(tenantId: string, id: string): Promise<DiscoveryNodeView | null> {
    const row = await this.prisma.client.discoveryNode.findFirst({
      where: { id, tenantId },
      include: NODE_INCLUDE,
    });
    return row ? toNode(row) : null;
  }

  async jobs(tenantId: string, status: string | null, first: number): Promise<DiscoveryJobView[]> {
    const where: Prisma.DiscoveryJobWhereInput = { tenantId };
    if (status !== null) where.status = status as JobRow['status'];
    const rows = await this.prisma.client.discoveryJob.findMany({
      where,
      orderBy: { scheduledAt: 'desc' },
      take: first,
    });
    return this.withStats(tenantId, rows);
  }

  async jobsBySweep(tenantId: string, sweepId: string): Promise<DiscoveryJobView[]> {
    const rows = await this.prisma.client.discoveryJob.findMany({
      where: { tenantId, options: { path: ['sweepId'], equals: sweepId } },
      orderBy: { scheduledAt: 'asc' },
    });
    return this.withStats(tenantId, rows);
  }

  private async withStats(tenantId: string, rows: JobRow[]): Promise<DiscoveryJobView[]> {
    const stats = new Map(
      (
        await this.runStats(
          tenantId,
          rows.map((r) => r.id),
        )
      ).map((s) => [s.jobId, s]),
    );
    return rows.map((r) => toJob(r, stats.get(r.id)));
  }

  async latestSweepId(tenantId: string): Promise<string | null> {
    const row = await this.prisma.client.discoveryJob.findFirst({
      where: { tenantId },
      orderBy: { scheduledAt: 'desc' },
    });
    return row ? sweepIdOf(row.options) : null;
  }

  async runStats(tenantId: string, jobIds: readonly string[]): Promise<JobRunStats[]> {
    if (jobIds.length === 0) return [];
    const runs = await this.prisma.client.collectorRun.findMany({
      where: { tenantId, jobId: { in: [...jobIds] } },
    });
    const out = new Map<string, JobRunStats>();
    for (const r of runs) {
      const s = out.get(r.jobId) ?? { jobId: r.jobId, cisEmitted: 0, errors: 0 };
      s.cisEmitted += r.cisEmitted;
      s.errors += Array.isArray(r.errors) ? r.errors.length : 0;
      out.set(r.jobId, s);
    }
    return [...out.values()];
  }

  async manifests(): Promise<CollectorManifest[]> {
    const rows = await this.prisma.client.collectorManifest.findMany({
      orderBy: [{ collectorId: 'asc' }, { version: 'desc' }],
    });
    const latest = new Map<string, CollectorManifest>();
    for (const r of rows) {
      if (latest.has(r.collectorId)) continue;
      const parsed = collectorManifestSchema.safeParse({
        id: r.collectorId,
        family: r.family,
        version: r.version,
        language: r.language,
        protocols: r.protocols,
        credentialTypes: r.credentialTypes,
        targetKinds: r.targetKinds,
        emits: r.emits,
        contractVersion: r.contractVersion,
      });
      if (parsed.success) latest.set(r.collectorId, parsed.data);
    }
    return [...latest.values()];
  }

  async secondsPerTarget(tenantId: string): Promise<Record<string, number>> {
    const grouped = await this.prisma.client.collectorRun.groupBy({
      by: ['collectorId'],
      where: { tenantId, targetsAttempted: { gt: 0 } },
      _sum: { durationMs: true, targetsAttempted: true },
    });
    const out: Record<string, number> = {};
    for (const g of grouped) {
      const ms = g._sum.durationMs ?? 0;
      const targets = g._sum.targetsAttempted ?? 0;
      if (targets > 0) out[g.collectorId] = ms / targets / TIME.msPerSecond;
    }
    return out;
  }

  async sites(siteIds: readonly string[]): Promise<SiteRef[]> {
    if (siteIds.length === 0) return [];
    return this.prisma.client.site.findMany({
      where: { id: { in: [...siteIds] } },
      select: { id: true, ciId: true },
    });
  }

  async sitesByCiIds(ciIds: readonly string[]): Promise<SiteRef[]> {
    if (ciIds.length === 0) return [];
    return this.prisma.client.site.findMany({
      where: { ciId: { in: [...ciIds] } },
      select: { id: true, ciId: true },
    });
  }

  async createJobs(tx: Prisma.TransactionClient, jobs: readonly CollectorJob[]): Promise<void> {
    if (jobs.length === 0) return;
    await tx.discoveryJob.createMany({
      data: jobs.map((j) => ({
        id: j.jobId,
        tenantId: j.tenantId,
        collectorId: j.collectorId,
        nodeId: j.nodeId,
        targets: j.targets as unknown as Prisma.InputJsonArray,
        credentialRef: j.credentialRef,
        credentialType: j.credentialType,
        timeoutMs: j.timeoutMs,
        rateLimitConcurrency: j.rateLimit.concurrency,
        rateLimitRps: j.rateLimit.requestsPerSecond,
        options: j.options as Prisma.InputJsonObject,
        scheduledAt: new Date(j.scheduledAt),
        contractVersion: j.contractVersion,
      })),
    });
  }
}
