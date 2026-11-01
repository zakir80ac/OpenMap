// REQ-DISC-029 REQ-DISC-028 — discovery planning: turns scopes (CIDRs, hosts, clusters, accounts)
// into CollectorJobs assigned to the Discovery Node of the right site, chunked for the sweep budget.
import { randomUUID } from 'node:crypto';
import { DISCOVERY, PERF_BUDGETS, TIME } from '@openmap/constants';
import { collectorJobSchema, type CollectorJob, type CollectorManifest, type Target } from '@openmap/contracts';
import { formatIpv4, hosts, parseCidr, type Cidr } from './cidr.js';

export interface Scope {
  id: string;
  siteId: string;
  /** Collector family ids to run against this scope, e.g. ['snmp', 'ssh_agentless']. */
  collectorIds: string[];
  targets: Target[];
  /** CIDRs never to touch, e.g. OT networks. */
  exclusions: string[];
  credentialRef: string | null;
  credentialType: CollectorJob['credentialType'];
  /** Per-scope ceilings (REQ-DISC-029); null falls back to DISCOVERY defaults and the Node's advertised concurrency. */
  rateLimit: { concurrency: number | null; requestsPerSecond: number | null };
  options: Record<string, unknown>;
}

export interface NodeInfo {
  nodeId: string;
  siteId: string;
  online: boolean;
  /** Concurrency the Node advertises; the planner never exceeds it. */
  maxConcurrency: number;
}

export interface Plan {
  sweepId: string;
  jobs: CollectorJob[];
  /** Scopes that had no online Node at their site. */
  unassignedScopeIds: string[];
  /** Expected duration under the planned concurrency, used to check the 15-minute budget. */
  estimatedMinutes: number;
  targetsTotal: number;
}

export interface PlannerInput {
  tenantId: string;
  scopes: Scope[];
  nodes: NodeInfo[];
  manifests: CollectorManifest[];
  /** Seconds a single target takes on average per collector family, from past runs; default when absent. */
  secondsPerTarget: Record<string, number>;
  defaultSecondsPerTarget: number;
  now: string;
}

function expand(targets: readonly Target[], exclusions: readonly Cidr[]): Target[] {
  const out: Target[] = [];
  for (const t of targets) {
    if (t.kind !== 'cidr') {
      out.push(t);
      continue;
    }
    const cidr = parseCidr(t.value);
    if (cidr.size > DISCOVERY.maxCidrExpansion) {
      // Too large to enumerate: keep as a CIDR target and let the collector scan.
      out.push(t);
      continue;
    }
    for (const a of hosts(cidr, exclusions)) out.push({ kind: 'host', value: formatIpv4(a) });
  }
  return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function pickNode(nodes: readonly NodeInfo[], siteId: string, roundRobin: Map<string, number>): NodeInfo | undefined {
  const candidates = nodes.filter((n) => n.siteId === siteId && n.online);
  if (candidates.length === 0) return undefined;
  const i = roundRobin.get(siteId) ?? 0;
  roundRobin.set(siteId, i + 1);
  return candidates[i % candidates.length];
}

export function plan(input: PlannerInput): Plan {
  const sweepId = randomUUID();
  const jobs: CollectorJob[] = [];
  const unassignedScopeIds: string[] = [];
  const roundRobin = new Map<string, number>();
  const manifestById = new Map(input.manifests.map((m) => [m.id, m]));
  let targetsTotal = 0;
  let seconds = 0;
  for (const scope of input.scopes) {
    const exclusions = scope.exclusions.map(parseCidr);
    const expanded = expand(scope.targets, exclusions);
    for (const collectorId of scope.collectorIds) {
      const manifest = manifestById.get(collectorId);
      if (!manifest) continue;
      const supported = expanded.filter((t) => manifest.targetKinds.includes(t.kind));
      if (supported.length === 0) continue;
      const node = pickNode(input.nodes, scope.siteId, roundRobin);
      if (!node) {
        unassignedScopeIds.push(scope.id);
        break;
      }
      const concurrency = Math.min(scope.rateLimit.concurrency ?? DISCOVERY.defaultConcurrency, node.maxConcurrency);
      const requestsPerSecond = scope.rateLimit.requestsPerSecond ?? DISCOVERY.defaultRequestsPerSecond;
      const perTarget = input.secondsPerTarget[collectorId] ?? input.defaultSecondsPerTarget;
      for (const targets of chunk(supported, DISCOVERY.targetsPerJob)) {
        jobs.push(
          collectorJobSchema.parse({
            jobId: randomUUID(),
            tenantId: input.tenantId,
            collectorId,
            nodeId: node.nodeId,
            targets,
            credentialRef: scope.credentialRef,
            credentialType: scope.credentialType,
            timeoutMs: DISCOVERY.defaultJobTimeoutMs,
            rateLimit: { concurrency, requestsPerSecond },
            options: { ...scope.options, sweepId, scopeId: scope.id },
            scheduledAt: input.now,
            contractVersion: manifest.contractVersion,
          }),
        );
        targetsTotal += targets.length;
        seconds += (targets.length * perTarget) / concurrency;
      }
    }
  }
  const nodeCount = Math.max(1, new Set(jobs.map((j) => j.nodeId)).size);
  const estimatedMinutes = seconds / nodeCount / TIME.secondsPerMinute;
  return { sweepId, jobs, unassignedScopeIds, estimatedMinutes, targetsTotal };
}

/** True when the plan fits the discovery budget for its size (scaled from the 10k-device target). */
export function withinBudget(p: Plan): boolean {
  const budgetMinutes = PERF_BUDGETS.discoverySweepMinutes * Math.max(1, p.targetsTotal / PERF_BUDGETS.discoverySweepDevices);
  return p.estimatedMinutes <= budgetMinutes;
}

/** Next retry delay for a retryable error, or null when attempts are exhausted. */
export function retryDelayMs(attempt: number): number | null {
  return DISCOVERY.retryBackoffMs[attempt] ?? null;
}
