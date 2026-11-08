// REQ-AI-005 (ADR-054) — the cloud recommendation model, a pure function over each cloud resource's state, monthly
// cost and load samples (CLOUD_ADVICE):
// - a stopped resource that still costs money: release it (saves its monthly cost);
// - running compute whose peak load stays at or under idlePeakPercent: decommission it (saves its monthly cost);
// - running compute whose peak and average stay under the rightsize lines: one size down (saves rightsizeSavingShare);
// - running compute averaging at or over upsizeAveragePercent: one size up (no saving; it is headroom).
// Every recommendation carries the figures it rests on, so the person can check it.
import { CLOUD_ADVICE } from '@openmap/constants';
import type { CloudRecommendationKind } from '@openmap/contracts';

export interface CloudResourceFacts {
  ciId: string;
  name: string;
  resourceType: string | null;
  state: string | null;
  monthlyCostUsd: number | null;
  sku: string | null;
  /** Load samples in percent over the lookback window; the latest sample alone when the window holds none. */
  loads: readonly number[];
  /** Epoch milliseconds of the newest load sample, or null without one. */
  loadAt: number | null;
}

export interface CloudRecommendation {
  ciId: string;
  kind: CloudRecommendationKind;
  /** Estimated monthly saving in USD; 0 for an upsize. */
  savingUsd: number;
  averageLoad: number | null;
  peakLoad: number | null;
  samples: number;
}

const COMPUTE: ReadonlySet<string> = new Set(CLOUD_ADVICE.computeTypes);
const STOPPED: ReadonlySet<string> = new Set(CLOUD_ADVICE.stoppedStates);

function money(n: number): number {
  return Number(n.toFixed(CLOUD_ADVICE.moneyDecimals));
}

/** The recommendation for one resource, or null when it is used about right (or there is nothing to go on). */
export function recommendForResource(r: CloudResourceFacts): CloudRecommendation | null {
  const cost = r.monthlyCostUsd ?? 0;
  const samples = r.loads.length;
  const averageLoad = samples === 0 ? null : r.loads.reduce((a, b) => a + b, 0) / samples;
  const peakLoad = samples === 0 ? null : Math.max(...r.loads);
  const base = { ciId: r.ciId, averageLoad, peakLoad, samples };
  if (r.state !== null && STOPPED.has(r.state.toLowerCase())) return cost > 0 ? { ...base, kind: 'release_stopped', savingUsd: money(cost) } : null;
  if (r.resourceType === null || !COMPUTE.has(r.resourceType) || averageLoad === null || peakLoad === null) return null;
  if (peakLoad <= CLOUD_ADVICE.idlePeakPercent) return { ...base, kind: 'decommission_idle', savingUsd: money(cost) };
  if (averageLoad >= CLOUD_ADVICE.upsizeAveragePercent) return { ...base, kind: 'upsize', savingUsd: 0 };
  if (peakLoad <= CLOUD_ADVICE.rightsizePeakPercent && averageLoad <= CLOUD_ADVICE.rightsizeAveragePercent)
    return { ...base, kind: 'downsize', savingUsd: money(cost * CLOUD_ADVICE.rightsizeSavingShare) };
  return null;
}

/** Recommendations for every resource, the largest saving first. */
export function recommendCloud(resources: readonly CloudResourceFacts[]): CloudRecommendation[] {
  return resources
    .map(recommendForResource)
    .filter((r): r is CloudRecommendation => r !== null)
    .sort((a, b) => b.savingUsd - a.savingUsd || a.ciId.localeCompare(b.ciId));
}
