// REQ-DISC-029 REQ-DISC-028 — job store over Prisma: persist planned jobs, let Nodes pull their
// scheduled work atomically (FOR UPDATE SKIP LOCKED), record results and evidence, and emit the
// discovery events through the outbox.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS, DNS_SYNC } from '@openmap/constants';
import { collectorResultSchema, eventEnvelopeSchema, type CollectorJob, type CollectorResult, type EventEnvelope, type EventType } from '@openmap/contracts';
import type { Prisma, PrismaClient } from '@openmap/db';
import { settleDnsJob } from './dns-sync-loop.js';

/** Contract objects are plain JSON; Prisma's input type is narrower only in its TypeScript shape. */
function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export const SCHEDULER_SOURCE = '/openmap/scheduler';

export function discoveryEvent(tenantId: string, type: EventType, subject: string, data: Record<string, unknown>): EventEnvelope {
  return eventEnvelopeSchema.parse({
    specversion: '1.0',
    id: randomUUID(),
    source: SCHEDULER_SOURCE,
    type,
    subject,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    dataschema: 'openmap/contracts/event/' + CONTRACT_VERSIONS.event,
    tenantid: tenantId,
    data,
  });
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

async function enqueueOutbox(tx: Tx, envelope: EventEnvelope): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      eventId: envelope.id,
      tenantId: envelope.tenantid,
      type: envelope.type,
      subject: envelope.subject,
      envelope: json(envelope),
      pending: ['clickhouse', 'websocket', 'bsm'],
    },
  });
}

export interface JobStore {
  schedule(jobs: readonly CollectorJob[]): Promise<number>;
  pull(nodeId: string, capacity: number, collectors: readonly string[]): Promise<CollectorJob[]>;
  complete(result: CollectorResult): Promise<{ runId: string }>;
}

function toContractJob(row: {
  id: string; tenantId: string; collectorId: string; nodeId: string; targets: unknown; credentialRef: string | null; credentialType: string;
  timeoutMs: number; rateLimitConcurrency: number; rateLimitRps: number; options: unknown; scheduledAt: Date; contractVersion: string;
}): CollectorJob {
  return {
    jobId: row.id,
    tenantId: row.tenantId,
    collectorId: row.collectorId,
    nodeId: row.nodeId,
    targets: row.targets as CollectorJob['targets'],
    credentialRef: row.credentialRef,
    credentialType: row.credentialType as CollectorJob['credentialType'],
    timeoutMs: row.timeoutMs,
    rateLimit: { concurrency: row.rateLimitConcurrency, requestsPerSecond: row.rateLimitRps },
    options: row.options as Record<string, unknown>,
    scheduledAt: row.scheduledAt.toISOString(),
    contractVersion: row.contractVersion,
  };
}

export function createJobStore(prisma: PrismaClient): JobStore {
  return {
    async schedule(jobs) {
      if (jobs.length === 0) return 0;
      return prisma.$transaction(async (tx) => {
        for (const job of jobs) {
          await tx.discoveryJob.create({
            data: {
              id: job.jobId,
              tenantId: job.tenantId,
              collectorId: job.collectorId,
              nodeId: job.nodeId,
              targets: json(job.targets),
              credentialRef: job.credentialRef,
              credentialType: job.credentialType,
              timeoutMs: job.timeoutMs,
              rateLimitConcurrency: job.rateLimit.concurrency,
              rateLimitRps: job.rateLimit.requestsPerSecond,
              options: json(job.options),
              scheduledAt: new Date(job.scheduledAt),
              status: 'scheduled',
              contractVersion: job.contractVersion,
            },
          });
          await enqueueOutbox(tx, discoveryEvent(job.tenantId, 'openmap.discovery.job.scheduled', job.jobId, { collectorId: job.collectorId, nodeId: job.nodeId, targets: job.targets.length }));
        }
        return jobs.length;
      });
    },

    async pull(nodeId, capacity, collectors) {
      if (capacity <= 0) return [];
      return prisma.$transaction(async (tx) => {
        // Lock the oldest scheduled rows for this node so two pulls never hand out the same job.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM discovery_jobs
          WHERE "nodeId" = ${nodeId} AND status = 'scheduled'::"JobStatus"
            AND (${collectors.length} = 0 OR "collectorId" = ANY(${collectors}::text[]))
          ORDER BY "scheduledAt" ASC
          LIMIT ${capacity}
          FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return [];
        const ids = locked.map((r) => r.id);
        const now = new Date();
        await tx.discoveryJob.updateMany({ where: { id: { in: ids } }, data: { status: 'started', startedAt: now } });
        const rows = await tx.discoveryJob.findMany({ where: { id: { in: ids } } });
        for (const row of rows) await enqueueOutbox(tx, discoveryEvent(row.tenantId, 'openmap.discovery.job.started', row.id, { nodeId, collectorId: row.collectorId }));
        return rows.map(toContractJob);
      });
    },

    async complete(input) {
      const result = collectorResultSchema.parse(input);
      return prisma.$transaction(async (tx) => {
        const job = await tx.discoveryJob.findUnique({ where: { id: result.jobId } });
        if (!job) throw new JobNotFound(result.jobId);
        if (job.nodeId !== result.nodeId) throw new JobNodeMismatch(result.jobId, job.nodeId, result.nodeId);
        const run = await tx.collectorRun.create({
          data: {
            id: result.runId,
            tenantId: job.tenantId,
            jobId: job.id,
            collectorId: result.collectorId,
            nodeId: result.nodeId,
            status: result.status,
            startedAt: new Date(result.startedAt),
            finishedAt: new Date(result.finishedAt),
            targetsAttempted: result.metrics.targetsAttempted,
            targetsReached: result.metrics.targetsReached,
            cisEmitted: result.metrics.cisEmitted,
            relationshipsEmitted: result.metrics.relationshipsEmitted,
            durationMs: result.metrics.durationMs,
            errors: json(result.errors),
            contractVersion: result.contractVersion,
            evidence: {
              create: result.evidence.map((e) => ({
                tenantId: job.tenantId,
                kind: e.kind,
                targetKind: e.target.kind,
                targetValue: e.target.value,
                targetLabel: e.target.label ?? null,
                digest: e.digest,
                sizeBytes: BigInt(e.sizeBytes),
                capturedAt: new Date(e.capturedAt),
              })),
            },
          },
        });
        // REQ-IPAM-003: a dns sync job settles the record changes it carried from the transfer it returned.
        if (job.collectorId === DNS_SYNC.collectorId) await settleDnsJob(tx, job, result);
        const status = result.status === 'failed' ? 'failed' : 'completed';
        await tx.discoveryJob.update({ where: { id: job.id }, data: { status, finishedAt: new Date(result.finishedAt) } });
        const type: EventType = status === 'failed' ? 'openmap.discovery.job.failed' : 'openmap.discovery.job.completed';
        await enqueueOutbox(tx, discoveryEvent(job.tenantId, type, job.id, { runId: run.id, status: result.status, cis: result.cis.length, relationships: result.relationships.length, errors: result.errors.length }));
        return { runId: run.id };
      });
    },
  };
}

export class JobNotFound extends Error {
  constructor(public readonly jobId: string) {
    super('job ' + jobId + ' does not exist');
    this.name = 'JobNotFound';
  }
}

export class JobNodeMismatch extends Error {
  constructor(public readonly jobId: string, public readonly expected: string, public readonly actual: string) {
    super('job ' + jobId + ' belongs to node ' + expected + ', result came from ' + actual);
    this.name = 'JobNodeMismatch';
  }
}
