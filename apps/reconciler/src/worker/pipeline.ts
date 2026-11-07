// REQ-CORE-013 — one collector result through lookup → reconcile → persist. Relationships whose
// endpoints are not yet known are parked in pending_relationships and retried after later results
// land, so a sweep resolves cross-collector references no matter which result arrives first. The same pass retries
// CIs whose `*Ref` values named no single known CI and folds copies that share a ref key (ADR-045).
import { CONTRACT_VERSIONS, RECONCILER, TIME } from '@openmap/constants';
import type { CollectorResult, ObservedRelationship } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { reconcile } from '../core/reconcile.js';
import { loadLookup } from './lookup.js';
import { persist, type PersistSummary } from './persist.js';
import { foldRefDuplicates, runRefPass, type RefPassSummary } from './refs.js';

export interface PipelineSummary extends PersistSummary {
  unchanged: number;
  unresolvedRelationships: number;
  /** Metric samples bound to a CI and queued for ClickHouse, and those whose CI the result did not resolve. */
  samples: number;
  samplesDropped: number;
  durationMs: number;
  /** Phase split of durationMs, so throughput work targets the right store. */
  lookupMs: number;
  reconcileMs: number;
  persistMs: number;
  /** CPU time (user + system) the process consumed inside the synchronous reconcile phase. */
  reconcileCpuMs: number;
  /** ADR-045: CIs folded into another CI with the same ref key after this result landed. */
  folded: number;
}

function cpuMs(since: NodeJS.CpuUsage): number {
  const d = process.cpuUsage(since);
  return (d.user + d.system) / TIME.microsecondsPerMillisecond;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function park(prisma: PrismaClient, result: CollectorResult, rels: readonly ObservedRelationship[]): Promise<void> {
  if (rels.length === 0) return;
  await prisma.pendingRelationship.createMany({
    data: rels.map((r) => ({
      tenantId: result.tenantId,
      type: r.type,
      fromRef: json(r.from),
      toRef: json(r.to),
      attributes: json(r.attributes),
      observedAt: new Date(r.observedAt),
      sourceCollectorId: result.collectorId,
      sourceNodeId: result.nodeId,
      sourceRunId: result.runId,
    })),
  });
}

export async function processResult(prisma: PrismaClient, result: CollectorResult): Promise<PipelineSummary> {
  const started = Date.now();
  let lookupMs = 0;
  let reconcileMs = 0;
  let persistMs = 0;
  const timed = async <T>(fn: () => Promise<T>, add: (ms: number) => void): Promise<T> => {
    const t0 = Date.now();
    const v = await fn();
    add(Date.now() - t0);
    return v;
  };
  const lookup = await timed(() => loadLookup(prisma, result), (ms) => (lookupMs += ms));
  const t1 = Date.now();
  const cpu1 = process.cpuUsage();
  const out = reconcile(result, lookup);
  const reconcileCpuMs = cpuMs(cpu1);
  reconcileMs += Date.now() - t1;
  const summary = await timed(() => persist(prisma, result.tenantId, out), (ms) => (persistMs += ms));
  let unresolved = out.unresolvedRelationships;
  if (unresolved.length > 0) {
    // Endpoints created by this very result are visible now; retry once before parking the rest.
    const retry: CollectorResult = { ...result, cis: [], relationships: unresolved, samples: [] };
    const lookup2 = await timed(() => loadLookup(prisma, retry), (ms) => (lookupMs += ms));
    const t2 = Date.now();
    const out2 = reconcile(retry, lookup2);
    reconcileMs += Date.now() - t2;
    const s2 = await timed(() => persist(prisma, result.tenantId, out2), (ms) => (persistMs += ms));
    summary.relationships += s2.relationships;
    summary.events += s2.events;
    unresolved = out2.unresolvedRelationships;
    await timed(() => park(prisma, result, unresolved), (ms) => (persistMs += ms));
  }
  // ADR-045: a CI this result created under a ref key another CI already holds (written concurrently, or before its
  // parent's identity was known here) is folded into the older one.
  const refKeys = [...out.refKeys.values()].filter((k): k is string => k !== null);
  const folded = await timed(() => foldRefDuplicates(prisma, result.tenantId, refKeys), (ms) => (persistMs += ms));
  return { ...summary, folded, unchanged: out.unchanged, unresolvedRelationships: unresolved.length, samples: out.samples, samplesDropped: out.samplesDropped, durationMs: Date.now() - started, lookupMs, reconcileMs, persistMs, reconcileCpuMs };
}

/**
 * Retries pending refs (ADR-045) and parked relationships for a tenant; resolved ones are persisted, exhausted
 * relationships dropped. Refs go first: a relationship may name a CI by a ref that only now resolves.
 */
export async function retryPendingRelationships(prisma: PrismaClient, tenantId: string): Promise<{ tried: number; resolved: number; dropped: number; refs: RefPassSummary }> {
  const refs = await runRefPass(prisma, tenantId);
  const rows = await prisma.pendingRelationship.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' }, take: RECONCILER.pendingRelationshipBatch });
  if (rows.length === 0) return { tried: 0, resolved: 0, dropped: 0, refs };
  const bySource = new Map<string, { rows: typeof rows; result: CollectorResult }>();
  for (const row of rows) {
    const key = row.sourceRunId;
    const entry = bySource.get(key) ?? {
      rows: [],
      result: {
        jobId: row.sourceRunId, runId: row.sourceRunId, tenantId, collectorId: row.sourceCollectorId, nodeId: row.sourceNodeId, status: 'success',
        startedAt: row.observedAt.toISOString(), finishedAt: row.observedAt.toISOString(), cis: [], relationships: [], samples: [], evidence: [], errors: [],
        metrics: { targetsAttempted: 0, targetsReached: 0, cisEmitted: 0, relationshipsEmitted: 0, durationMs: 0 }, contractVersion: CONTRACT_VERSIONS.collector,
      },
    };
    entry.rows.push(row);
    entry.result.relationships.push({ type: row.type, from: row.fromRef as ObservedRelationship['from'], to: row.toRef as ObservedRelationship['to'], attributes: row.attributes as ObservedRelationship['attributes'], observedAt: row.observedAt.toISOString() });
    bySource.set(key, entry);
  }
  let resolved = 0;
  let dropped = 0;
  for (const { rows: group, result } of bySource.values()) {
    const out = reconcile(result, await loadLookup(prisma, result));
    await persist(prisma, tenantId, out);
    resolved += out.relationshipsCreated.length + out.relationshipsSeen.length;
    const stillPending = new Set(out.unresolvedRelationships.map((r) => JSON.stringify([r.type, r.from, r.to])));
    const doneIds = group.filter((row) => !stillPending.has(JSON.stringify([row.type, row.fromRef, row.toRef]))).map((row) => row.id);
    if (doneIds.length) await prisma.pendingRelationship.deleteMany({ where: { id: { in: doneIds } } });
    const remaining = group.filter((row) => !doneIds.includes(row.id));
    const exhausted = remaining.filter((row) => row.attempts + 1 >= RECONCILER.pendingRelationshipMaxAttempts).map((row) => row.id);
    if (exhausted.length) {
      await prisma.pendingRelationship.deleteMany({ where: { id: { in: exhausted } } });
      dropped += exhausted.length;
    }
    const bump = remaining.filter((row) => !exhausted.includes(row.id)).map((row) => row.id);
    if (bump.length) await prisma.pendingRelationship.updateMany({ where: { id: { in: bump } }, data: { attempts: { increment: 1 } } });
  }
  return { tried: rows.length, resolved, dropped, refs };
}

/** Whether a pending pass changed anything, so a replay knows when another pass has nothing left to do. */
export function pendingProgressed(r: Awaited<ReturnType<typeof retryPendingRelationships>>): boolean {
  return (r.tried > 0 && r.resolved > 0) || r.refs.tokens > 0 || r.refs.resolved > 0 || r.refs.folded > 0;
}
