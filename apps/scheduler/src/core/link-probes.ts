// REQ-BSM-007 (ADR-025) — link probe planning: every inter-site link with a probe target becomes a link_probe target
// for a Node at its A-end site that offers the collector, else for any online Node of the tenant that does. One job
// per Node per round; a Node whose previous link-probe job has not finished is skipped so jobs never stack.
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSIONS, LINK_PROBE } from '@openmap/constants';
import type { CollectorJob } from '@openmap/contracts';

export interface ProbeLink {
  tenantId: string;
  /** The site_link CI id: the probe's samples land on it. */
  ciId: string;
  /** Site code of the A end (the link CI's fromSiteRef). */
  fromSiteCode: string | null;
  probeTarget: string;
}

export interface ProbeNode {
  id: string;
  tenantId: string;
  siteCode: string;
  online: boolean;
  collectorIds: readonly string[];
}

export interface PlannedProbes {
  jobs: CollectorJob[];
  /** Links no online Node with the collector could take this round. */
  unassigned: number;
}

export function planLinkProbes(links: readonly ProbeLink[], nodes: readonly ProbeNode[], busyNodeIds: ReadonlySet<string>, now: string): PlannedProbes {
  const capable = nodes.filter((n) => n.online && n.collectorIds.includes(LINK_PROBE.collectorId)).sort((a, b) => a.id.localeCompare(b.id));
  const byNode = new Map<string, { node: ProbeNode; links: ProbeLink[] }>();
  let unassigned = 0;
  for (const link of links) {
    const tenantNodes = capable.filter((n) => n.tenantId === link.tenantId);
    const node = tenantNodes.find((n) => n.siteCode === link.fromSiteCode) ?? tenantNodes[0];
    if (node === undefined) {
      unassigned += 1;
      continue;
    }
    const entry = byNode.get(node.id) ?? { node, links: [] };
    entry.links.push(link);
    byNode.set(node.id, entry);
  }
  const jobs: CollectorJob[] = [];
  for (const { node, links: assigned } of byNode.values()) {
    if (busyNodeIds.has(node.id)) continue;
    jobs.push({
      jobId: randomUUID(),
      tenantId: node.tenantId,
      collectorId: LINK_PROBE.collectorId,
      nodeId: node.id,
      targets: assigned.map((l) => ({ kind: 'host', value: l.probeTarget, label: l.ciId })),
      credentialRef: null,
      credentialType: 'none',
      timeoutMs: LINK_PROBE.jobTimeoutMs,
      rateLimit: { concurrency: assigned.length, requestsPerSecond: 0 },
      options: { attempts: LINK_PROBE.attempts, timeoutMs: LINK_PROBE.timeoutMs, gapMs: LINK_PROBE.gapMs, port: LINK_PROBE.defaultPort },
      scheduledAt: now,
      contractVersion: CONTRACT_VERSIONS.collector,
    });
  }
  return { jobs, unassigned };
}
