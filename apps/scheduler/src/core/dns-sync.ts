// REQ-IPAM-003 (ADR-055) — DNS sync planning: each zone kept in sync that has pending changes, or whose last pull is
// older than the pull interval, gets one `dns` job on an online Node of its site that offers the collector. The job
// carries the zone's pending changes (pushed as one RFC 2136 update) and transfers the zone, whose records then settle
// the changes. A zone with an unfinished job is skipped so changes are never sent twice.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS, DISCOVERY, DNS_SYNC } from '@openmap/constants';
import { collectorJobSchema, type CollectorJob } from '@openmap/contracts';

export interface ZoneSync {
  id: string;
  tenantId: string;
  zone: string;
  server: string;
  port: number;
  tsigKeyName: string | null;
  tsigAlgorithm: string | null;
  credentialRef: string | null;
  siteId: string;
  lastPullAt: Date | null;
}

export interface PendingChange {
  id: string;
  zone: string;
  op: string;
  name: string;
  recordType: string;
  value: string;
  ttl: number;
}

export interface SyncNode {
  id: string;
  tenantId: string;
  siteId: string;
  online: boolean;
  collectorIds: readonly string[];
}

export interface PlannedSync {
  jobs: CollectorJob[];
  /** Change id to the job carrying it. */
  sent: Map<string, string>;
  /** Zone sync id to the job planned for it. */
  zoneJobs: Map<string, string>;
  /** Zones that needed a job and had no online Node with the collector at their site. */
  unassigned: string[];
}

export function planDnsSync(syncs: readonly ZoneSync[], pending: ReadonlyMap<string, readonly PendingChange[]>, nodes: readonly SyncNode[], busySyncIds: ReadonlySet<string>, now: Date, pullEveryMs: number): PlannedSync {
  const out: PlannedSync = { jobs: [], sent: new Map(), zoneJobs: new Map(), unassigned: [] };
  for (const s of [...syncs].sort((a, b) => a.zone.localeCompare(b.zone))) {
    if (busySyncIds.has(s.id)) continue;
    const changes = pending.get(s.id) ?? [];
    const pullDue = s.lastPullAt === null || now.getTime() - s.lastPullAt.getTime() >= pullEveryMs;
    if (changes.length === 0 && !pullDue) continue;
    const node = nodes.filter((n) => n.online && n.tenantId === s.tenantId && n.siteId === s.siteId && n.collectorIds.includes(DNS_SYNC.collectorId)).sort((a, b) => a.id.localeCompare(b.id))[0];
    if (node === undefined) {
      out.unassigned.push(s.zone);
      continue;
    }
    const jobId = randomUUID();
    out.jobs.push(
      collectorJobSchema.parse({
        jobId,
        tenantId: s.tenantId,
        collectorId: DNS_SYNC.collectorId,
        nodeId: node.id,
        targets: [{ kind: 'host', value: s.server, label: s.zone }],
        credentialRef: s.credentialRef,
        credentialType: s.credentialRef === null ? 'none' : DNS_SYNC.credentialType,
        timeoutMs: DISCOVERY.defaultJobTimeoutMs,
        rateLimit: { concurrency: 1, requestsPerSecond: DISCOVERY.defaultRequestsPerSecond },
        options: {
          zones: [s.zone],
          port: s.port,
          ...(s.tsigKeyName === null ? {} : { tsigKeyName: s.tsigKeyName }),
          ...(s.tsigAlgorithm === null ? {} : { tsigAlgorithm: s.tsigAlgorithm }),
          updates: changes.map((c) => ({ zone: s.zone, op: c.op, name: c.name, type: c.recordType, value: c.value, ttl: c.ttl })),
          [DNS_SYNC.syncOption]: s.id,
        },
        scheduledAt: now.toISOString(),
        contractVersion: CONTRACT_VERSIONS.collector,
      }),
    );
    out.zoneJobs.set(s.id, jobId);
    for (const c of changes) out.sent.set(c.id, jobId);
  }
  return out;
}
