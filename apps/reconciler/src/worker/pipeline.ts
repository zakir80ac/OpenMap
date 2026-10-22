// REQ-CORE-013 — one collector result through lookup → reconcile → persist. Relationships whose
// endpoints are not yet known are parked in pending_relationships and retried after later results
// land, so a sweep resolves cross-collector references no matter which result arrives first.
import { RECONCILER } from '@openmap/constants';
import type { CollectorResult, ObservedRelationship } from '@openmap/contracts';
import { Prisma, type PrismaClient } from '@openmap/db';
import { reconcile } from '../core/reconcile.js';
import { loadLookup } from './lookup.js';
import { persist, type PersistSummary } from './persist.js';

export interface PipelineSummary extends PersistSummary {
  unchanged: number;
  unresolvedRelationships: number;
  durationMs: number;
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
  const lookup = await loadLookup(prisma, result);
  const out = reconcile(result, lookup);
  const summary = await persist(prisma, result.tenantId, out);
  let unresolved = out.unresolvedRelationships;
  if (unresolved.length > 0) {
    // Endpoints created by this very result are visible now; retry once before parking the rest.
    const retry: CollectorResult = { ...result, cis: [], relationships: unresolved };
    const out2 = reconcile(retry, await loadLookup(prisma, retry));
    const s2 = await persist(prisma, result.tenantId, out2);
    summary.relationships += s2.relationships;
    summary.events += s2.events;
    unresolved = out2.unresolvedRelationships;
    await park(prisma, result, unresolved);
  }
  return { ...summary, unchanged: out.unchanged, unresolvedRelationships: unresolved.length, durationMs: Date.now() - started };
}

/** Retries parked relationships for a tenant; resolved ones are persisted, exhausted ones dropped. */
export async function retryPendingRelationships(prisma: PrismaClient, tenantId: string): Promise<{ tried: number; resolved: number; dropped: number }> {
  const rows = await prisma.pendingRelationship.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' }, take: RECONCILER.pendingRelationshipBatch });
  if (rows.length === 0) return { tried: 0, resolved: 0, dropped: 0 };
  const bySource = new Map<string, { rows: typeof rows; result: CollectorResult }>();
  for (const row of rows) {
    const key = row.sourceRunId;
    const entry = bySource.get(key) ?? {
      rows: [],
      result: {
        jobId: row.sourceRunId, runId: row.sourceRunId, tenantId, collectorId: row.sourceCollectorId, nodeId: row.sourceNodeId, status: 'success',
        startedAt: row.observedAt.toISOString(), finishedAt: row.observedAt.toISOString(), cis: [], relationships: [], evidence: [], errors: [],
        metrics: { targetsAttempted: 0, targetsReached: 0, cisEmitted: 0, relationshipsEmitted: 0, durationMs: 0 }, contractVersion: '0.1.0',
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
  return { tried: rows.length, resolved, dropped };
}
