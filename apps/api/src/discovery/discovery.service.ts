// REQ-DISC-029 — discovery use cases: nodes, jobs, the current sweep, and runDiscovery which plans a
// sweep from subnet CIs and online Nodes through the scheduler planner and persists its jobs.
import { Inject, Injectable } from '@nestjs/common';
import { DISCOVERY, PERF_BUDGETS, TIME } from '@openmap/constants';
import { CREDENTIAL_TYPES, type CollectorJob, type RelationshipType } from '@openmap/contracts';
import { plan, type NodeInfo, type Scope } from '@openmap/scheduler';
import { CI_REPOSITORY, type CiRepository } from '../ci/ci.repository.js';
import type { CiRecord } from '../ci/ci.types.js';
import { clampPageSize } from '../common/cursor.js';
import { nowIso } from '../common/time.js';
import { numberAttribute, stringArrayAttribute, stringAttribute } from '../common/validation.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { DISCOVERY_REPOSITORY, type DiscoveryRepository } from './discovery.repository.js';
import type { DiscoveryJobView, DiscoveryNodeView, SweepView } from './discovery.types.js';

export const LOCATED_IN: RelationshipType = 'located_in';

/** A Node silent for longer than one job timeout is treated as offline by the planner. */
export const NODE_OFFLINE_AFTER_MS = DISCOVERY.defaultJobTimeoutMs;

/** Planner estimate when no past run exists: a job that uses its whole timeout for a full chunk. */
export const DEFAULT_SECONDS_PER_TARGET = DISCOVERY.defaultJobTimeoutMs / DISCOVERY.targetsPerJob / TIME.msPerSecond;

/** Subnet CI attributes that drive discovery scoping. */
export const SCOPE_ATTRIBUTES = { cidr: 'cidr', credentialRef: 'credentialRef', credentialType: 'credentialType', exclusions: 'exclusions', rateLimitConcurrency: 'rateLimitConcurrency', rateLimitRps: 'rateLimitRps' } as const;

export function budgetMinutesFor(targets: number): number {
  return Math.ceil(PERF_BUDGETS.discoverySweepMinutes * Math.max(1, targets / PERF_BUDGETS.discoverySweepDevices));
}

export function sweepFromJobs(sweepId: string, jobs: readonly DiscoveryJobView[]): SweepView {
  const done = jobs.filter((j) => j.status === 'completed' || j.status === 'failed');
  const started = jobs.map((j) => j.scheduledAt).sort()[0] ?? nowIso();
  const finished = done.length === jobs.length && jobs.length > 0 ? (jobs.map((j) => j.finishedAt).filter((f): f is string => f !== null).sort().at(-1) ?? null) : null;
  const targetsTotal = jobs.reduce((s, j) => s + j.targets, 0);
  return {
    id: sweepId,
    startedAt: started,
    finishedAt: finished,
    targetsTotal,
    targetsDone: done.reduce((s, j) => s + j.targets, 0),
    devicesDiscovered: jobs.reduce((s, j) => s + j.cisEmitted, 0),
    budgetMinutes: budgetMinutesFor(targetsTotal),
  };
}

const CREDENTIAL_TYPE_SET = new Set<string>(CREDENTIAL_TYPES);

@Injectable()
export class DiscoveryService {
  constructor(
    @Inject(DISCOVERY_REPOSITORY) private readonly repo: DiscoveryRepository,
    @Inject(CI_REPOSITORY) private readonly cis: CiRepository,
    private readonly outbox: OutboxService,
  ) {}

  nodes(tenantId: string): Promise<DiscoveryNodeView[]> {
    return this.repo.nodes(tenantId);
  }

  node(tenantId: string, id: string): Promise<DiscoveryNodeView | null> {
    return this.repo.node(tenantId, id);
  }

  jobs(tenantId: string, status: string | null, first: number | null | undefined): Promise<DiscoveryJobView[]> {
    return this.repo.jobs(tenantId, status, clampPageSize(first));
  }

  async currentSweep(tenantId: string): Promise<SweepView | null> {
    const sweepId = await this.repo.latestSweepId(tenantId);
    return sweepId === null ? null : this.sweep(tenantId, sweepId);
  }

  async sweep(tenantId: string, sweepId: string): Promise<SweepView> {
    return sweepFromJobs(sweepId, await this.repo.jobsBySweep(tenantId, sweepId));
  }

  async runDiscovery(tenantId: string, actor: string, collectorIds: readonly string[] | null, siteId: string | null): Promise<SweepView> {
    const now = nowIso();
    const [nodes, manifests, subnets, secondsPerTarget] = await Promise.all([this.repo.nodes(tenantId), this.repo.manifests(), this.cis.byType(tenantId, 'subnet'), this.repo.secondsPerTarget(tenantId)]);
    const wanted = collectorIds && collectorIds.length > 0 ? manifests.filter((m) => collectorIds.includes(m.id)) : manifests;
    const nodeInfos: NodeInfo[] = nodes
      .filter((n) => siteId === null || n.siteId === siteId)
      .map((n) => ({ nodeId: n.id, siteId: n.siteId, online: Date.parse(now) - Date.parse(n.lastHeartbeat) <= NODE_OFFLINE_AFTER_MS, maxConcurrency: DISCOVERY.defaultConcurrency }));
    const scopes = await this.scopesFor(tenantId, subnets, wanted.map((m) => m.id), nodeInfos, siteId);
    const planned = plan({ tenantId, scopes, nodes: nodeInfos, manifests: wanted, secondsPerTarget, defaultSecondsPerTarget: DEFAULT_SECONDS_PER_TARGET, now });
    await this.outbox.transaction(tenantId, async ({ tx, emit }) => {
      await this.repo.createJobs(tx, planned.jobs);
      for (const job of planned.jobs) {
        await emit({ type: 'openmap.discovery.job.scheduled', subject: job.jobId, data: { jobId: job.jobId, sweepId: planned.sweepId, collectorId: job.collectorId, nodeId: job.nodeId, targets: job.targets.length, scheduledAt: job.scheduledAt, by: actor } });
      }
      await emit({ type: 'openmap.audit.action', subject: planned.sweepId, data: { action: 'discovery.sweep.planned', sweepId: planned.sweepId, jobs: planned.jobs.length, targetsTotal: planned.targetsTotal, unassignedScopeIds: planned.unassignedScopeIds, estimatedMinutes: planned.estimatedMinutes, by: actor } });
    });
    return { id: planned.sweepId, startedAt: now, finishedAt: null, targetsTotal: planned.targetsTotal, targetsDone: 0, devicesDiscovered: 0, budgetMinutes: budgetMinutesFor(planned.targetsTotal) };
  }

  /** One scope per subnet CI with a CIDR, assigned to the site that houses it (or the only site with online Nodes). */
  private async scopesFor(tenantId: string, subnets: readonly CiRecord[], collectorIds: string[], nodes: readonly NodeInfo[], siteId: string | null): Promise<Scope[]> {
    const located = await this.cis.relationshipsOfMany(tenantId, subnets.map((s) => s.id), [LOCATED_IN], 'downstream');
    const siteCiIds = [...new Set(located.map((r) => r.toCiId))];
    const siteByCi = new Map((await this.repo.sitesByCiIds(siteCiIds)).map((s) => [s.ciId, s.id]));
    const onlineSites = [...new Set(nodes.filter((n) => n.online).map((n) => n.siteId))];
    const fallbackSite = siteId ?? (onlineSites.length === 1 ? onlineSites[0] : undefined);
    const scopes: Scope[] = [];
    for (const subnet of subnets) {
      const cidr = stringAttribute(subnet.attributes, SCOPE_ATTRIBUTES.cidr);
      if (cidr === null) continue;
      const siteCi = located.find((r) => r.fromCiId === subnet.id)?.toCiId;
      const scopeSite = (siteCi !== undefined ? siteByCi.get(siteCi) : undefined) ?? fallbackSite;
      if (scopeSite === undefined) continue;
      if (siteId !== null && scopeSite !== siteId) continue;
      const credentialType = stringAttribute(subnet.attributes, SCOPE_ATTRIBUTES.credentialType);
      scopes.push({
        id: subnet.id,
        siteId: scopeSite,
        collectorIds,
        targets: [{ kind: 'cidr', value: cidr, label: subnet.displayName }],
        exclusions: stringArrayAttribute(subnet.attributes, SCOPE_ATTRIBUTES.exclusions),
        credentialRef: stringAttribute(subnet.attributes, SCOPE_ATTRIBUTES.credentialRef),
        credentialType: credentialType !== null && CREDENTIAL_TYPE_SET.has(credentialType) ? (credentialType as CollectorJob['credentialType']) : 'none',
        rateLimit: { concurrency: numberAttribute(subnet.attributes, SCOPE_ATTRIBUTES.rateLimitConcurrency), requestsPerSecond: numberAttribute(subnet.attributes, SCOPE_ATTRIBUTES.rateLimitRps) },
        options: {},
      });
    }
    return scopes;
  }
}
