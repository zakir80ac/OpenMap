// REQ-BSM-007 (ADR-025) — the continuous link probe: every LINK_PROBE_INTERVAL_MS the scheduler reads the current
// site_link CIs that name a probe target and the online Nodes that offer link_probe, plans one job per Node and
// schedules it like any other job. Nodes pull and run them; the samples reach ClickHouse through the reconciler.
import { CONNECTIVITY_ATTRIBUTES } from '@openmap/contracts';
import { DISCOVERY, LINK_PROBE } from '@openmap/constants';
import type { PrismaClient } from '@openmap/db';
import { planLinkProbes, type ProbeLink, type ProbeNode } from '../core/link-probes.js';
import type { JobStore } from './jobs.js';

const UNFINISHED = ['scheduled', 'started'] as const;

function stringAttr(attributes: unknown, key: string): string | null {
  if (attributes === null || typeof attributes !== 'object') return null;
  const v = (attributes as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export async function planRound(prisma: PrismaClient, jobs: JobStore, now = new Date()): Promise<{ scheduled: number; unassigned: number }> {
  const linkRows = await prisma.ci.findMany({ where: { type: 'site_link', validTo: null }, select: { id: true, tenantId: true, attributes: true, identity: true } });
  const links: ProbeLink[] = [];
  for (const row of linkRows) {
    const probeTarget = stringAttr(row.attributes, CONNECTIVITY_ATTRIBUTES.probeTarget);
    if (probeTarget === null) continue;
    links.push({ tenantId: row.tenantId, ciId: row.id, fromSiteCode: stringAttr(row.identity, CONNECTIVITY_ATTRIBUTES.fromSiteRef) ?? stringAttr(row.attributes, CONNECTIVITY_ATTRIBUTES.fromSiteRef), probeTarget });
  }
  if (links.length === 0) return { scheduled: 0, unassigned: 0 };
  // Online as the API counts it: a heartbeat within the default job timeout.
  const onlineSince = new Date(now.getTime() - DISCOVERY.defaultJobTimeoutMs);
  const nodeRows = await prisma.discoveryNode.findMany({
    where: { tenantId: { in: [...new Set(links.map((l) => l.tenantId))] }, collectorIds: { has: LINK_PROBE.collectorId } },
    select: { id: true, tenantId: true, lastHeartbeatAt: true, collectorIds: true, site: { select: { code: true } } },
  });
  const nodes: ProbeNode[] = nodeRows.map((n) => ({ id: n.id, tenantId: n.tenantId, siteCode: n.site.code, online: n.lastHeartbeatAt !== null && n.lastHeartbeatAt >= onlineSince, collectorIds: n.collectorIds }));
  // An unfinished job younger than staleJobMs holds its Node back; an older one (a Node that went away) does not.
  const busy = await prisma.discoveryJob.findMany({
    where: { collectorId: LINK_PROBE.collectorId, status: { in: [...UNFINISHED] }, scheduledAt: { gte: new Date(now.getTime() - LINK_PROBE.staleJobMs) } },
    select: { nodeId: true },
    distinct: ['nodeId'],
  });
  const planned = planLinkProbes(links, nodes, new Set(busy.map((b) => b.nodeId)), now.toISOString());
  const scheduled = await jobs.schedule(planned.jobs);
  // One probe job per Node per minute adds up: finished ones past LINK_PROBE.retainMs go, with their runs (cascade).
  await prisma.discoveryJob.deleteMany({ where: { collectorId: LINK_PROBE.collectorId, status: { in: ['completed', 'failed'] }, scheduledAt: { lt: new Date(now.getTime() - LINK_PROBE.retainMs) } } });
  return { scheduled, unassigned: planned.unassigned };
}

/** Starts the round timer; returns a stop function. A round still running is not started twice. */
export function startLinkProbes(prisma: PrismaClient, jobs: JobStore, everyMs: number, log: (line: Record<string, unknown>) => void): () => void {
  if (everyMs === 0) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    planRound(prisma, jobs)
      .then((r) => {
        if (r.scheduled > 0 || r.unassigned > 0) log({ msg: 'link probes planned', ...r });
      })
      .catch((err: unknown) => {
        log({ msg: 'link probe round failed', error: err instanceof Error ? err.message : String(err) });
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
