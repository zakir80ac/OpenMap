// REQ-IPAM-003 (ADR-055) — the DNS sync round and the settlement of its jobs:
// - every DNS_SYNC_INTERVAL_MS the scheduler reads the enabled zone syncs, their pending changes and the Nodes that
//   offer the dns collector, plans one job per zone that needs one (planDnsSync), schedules it and marks the changes
//   it carries as sent;
// - when that job's result comes back (JobStore.complete), the changes it carried are settled from the transfer: an
//   added record present, a deleted one absent, means applied; a failed job fails them with its error.
import { DISCOVERY, DNS_SYNC } from '@openmap/constants';
import { settleDnsChange, type CollectorResult } from '@openmap/contracts';
import type { Prisma, PrismaClient } from '@openmap/db';
import { planDnsSync, type PendingChange, type SyncNode, type ZoneSync } from '../core/dns-sync.js';
import type { JobStore } from './jobs.js';

const UNFINISHED = ['scheduled', 'started'] as const;

function syncIdOf(options: unknown): string | null {
  if (options === null || typeof options !== 'object') return null;
  const v = (options as Record<string, unknown>)[DNS_SYNC.syncOption];
  return typeof v === 'string' ? v : null;
}

export async function planDnsRound(prisma: PrismaClient, jobs: JobStore, pullEveryMs: number, now = new Date()): Promise<{ scheduled: number; sent: number; unassigned: string[] }> {
  const syncRows = await prisma.dnsZoneSync.findMany({ where: { enabled: true } });
  if (syncRows.length === 0) return { scheduled: 0, sent: 0, unassigned: [] };
  const syncs: ZoneSync[] = syncRows.map((s) => ({ id: s.id, tenantId: s.tenantId, zone: s.zone, server: s.server, port: s.port, tsigKeyName: s.tsigKeyName, tsigAlgorithm: s.tsigAlgorithm, credentialRef: s.credentialRef, siteId: s.siteId, lastPullAt: s.lastPullAt }));
  const changeRows = await prisma.dnsChange.findMany({ where: { state: 'pending', OR: syncRows.map((s) => ({ tenantId: s.tenantId, zone: s.zone })) }, orderBy: { requestedAt: 'asc' } });
  const syncOf = new Map(syncRows.map((s) => [s.tenantId + '|' + s.zone, s.id]));
  const pending = new Map<string, PendingChange[]>();
  for (const c of changeRows) {
    const id = syncOf.get(c.tenantId + '|' + c.zone);
    if (id !== undefined) pending.set(id, [...(pending.get(id) ?? []), { id: c.id, zone: c.zone, op: c.op, name: c.name, recordType: c.recordType, value: c.value, ttl: c.ttl }]);
  }
  // Online as the API counts it: a heartbeat within the default job timeout.
  const onlineSince = new Date(now.getTime() - DISCOVERY.defaultJobTimeoutMs);
  const nodeRows = await prisma.discoveryNode.findMany({ where: { tenantId: { in: [...new Set(syncRows.map((s) => s.tenantId))] }, collectorIds: { has: DNS_SYNC.collectorId } } });
  const nodes: SyncNode[] = nodeRows.map((n) => ({ id: n.id, tenantId: n.tenantId, siteId: n.siteId, online: n.lastHeartbeatAt !== null && n.lastHeartbeatAt >= onlineSince, collectorIds: n.collectorIds }));
  const unfinished = await prisma.discoveryJob.findMany({
    where: { collectorId: DNS_SYNC.collectorId, status: { in: [...UNFINISHED] }, scheduledAt: { gte: new Date(now.getTime() - DNS_SYNC.staleJobMs) } },
    select: { options: true },
  });
  const busy = new Set(unfinished.map((j) => syncIdOf(j.options)).filter((id): id is string => id !== null));
  const planned = planDnsSync(syncs, pending, nodes, busy, now, pullEveryMs);
  const scheduled = await jobs.schedule(planned.jobs);
  for (const [changeId, jobId] of planned.sent) await prisma.dnsChange.update({ where: { id: changeId }, data: { state: 'sent', jobId } });
  for (const [syncId, jobId] of planned.zoneJobs) await prisma.dnsZoneSync.update({ where: { id: syncId }, data: { lastJobId: jobId } });
  return { scheduled, sent: planned.sent.size, unassigned: planned.unassigned };
}

/** Settles the changes a finished dns sync job carried, inside the transaction that records its run. */
export async function settleDnsJob(tx: Prisma.TransactionClient, job: { id: string; options: unknown }, result: CollectorResult): Promise<number> {
  const syncId = syncIdOf(job.options);
  if (syncId === null) return 0;
  const now = new Date();
  const changes = await tx.dnsChange.findMany({ where: { jobId: job.id, state: 'sent' } });
  const failedError = result.status === 'failed' ? (result.errors[0]?.message ?? 'the dns job failed') : null;
  const records = result.cis
    .filter((c) => c.type === 'dns_record')
    .map((c) => ({ name: c.identity['name'] ?? '', recordType: c.identity['recordType'] ?? '', value: c.identity['value'] ?? '' }));
  for (const c of changes) {
    const state = failedError !== null ? 'failed' : settleDnsChange(records, c);
    const error = failedError ?? (state === 'failed' ? (c.op === 'add' ? 'the zone transfer after the update does not hold the record' : 'the zone transfer after the update still holds the record') : null);
    await tx.dnsChange.update({ where: { id: c.id }, data: { state, error, settledAt: now } });
  }
  await tx.dnsZoneSync.update({
    where: { id: syncId },
    data: {
      ...(failedError === null ? { lastPullAt: now } : {}),
      ...(changes.length > 0 && failedError === null ? { lastPushAt: now } : {}),
      lastError: failedError,
    },
  });
  return changes.length;
}

/** Starts the round timer; returns a stop function. A round still running is not started twice. */
export function startDnsSync(prisma: PrismaClient, jobs: JobStore, everyMs: number, pullEveryMs: number, log: (line: Record<string, unknown>) => void): () => void {
  if (everyMs === 0) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    planDnsRound(prisma, jobs, pullEveryMs)
      .then((r) => {
        if (r.scheduled > 0 || r.unassigned.length > 0) log({ msg: 'dns sync planned', ...r });
      })
      .catch((err: unknown) => {
        log({ msg: 'dns sync round failed', error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
