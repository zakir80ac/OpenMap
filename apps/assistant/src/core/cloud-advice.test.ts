// T-507 REQ-AI-005 — the cloud recommendation model: stopped and still billed is released, idle compute is
// decommissioned, compute far under its size is downsized at half its cost, hot compute is upsized, and a resource used
// about right, a non-compute resource or one without load gets nothing; the largest saving comes first.
import { describe, expect, it } from 'vitest';
import { CLOUD_ADVICE } from '@openmap/constants';
import { recommendCloud, recommendForResource, type CloudResourceFacts } from './cloud-advice.js';

const vm = (ciId: string, loads: number[], over: Partial<CloudResourceFacts> = {}): CloudResourceFacts => ({
  ciId, name: ciId, resourceType: 'AWS::EC2::Instance', state: 'running', monthlyCostUsd: 1000, sku: 'm6i.xlarge', loads, loadAt: 1, ...over,
});

describe('cloud recommendations', () => {
  it('advises each kind with its saving', () => {
    expect(recommendForResource(vm('stopped', [], { state: 'stopped', monthlyCostUsd: 352.51 }))).toMatchObject({ kind: 'release_stopped', savingUsd: 352.51 });
    expect(recommendForResource(vm('idle', [2, 4, CLOUD_ADVICE.idlePeakPercent]))).toMatchObject({ kind: 'decommission_idle', savingUsd: 1000, peakLoad: CLOUD_ADVICE.idlePeakPercent, samples: 3 });
    expect(recommendForResource(vm('small', [12, 20, 31]))).toMatchObject({ kind: 'downsize', savingUsd: 1000 * CLOUD_ADVICE.rightsizeSavingShare });
    expect(recommendForResource(vm('hot', [88, 91, 95]))).toMatchObject({ kind: 'upsize', savingUsd: 0 });
  });

  it('leaves a resource used about right, a non-compute one and one without load alone', () => {
    expect(recommendForResource(vm('fine', [35, 55, 70]))).toBeNull();
    expect(recommendForResource(vm('vpc', [1], { resourceType: 'AWS::EC2::VPC' }))).toBeNull();
    expect(recommendForResource(vm('unmeasured', []))).toBeNull();
    expect(recommendForResource(vm('stopped-free', [], { state: 'stopped', monthlyCostUsd: 0 }))).toBeNull();
  });

  it('orders by saving', () => {
    const recs = recommendCloud([vm('small', [20]), vm('idle', [1]), vm('hot', [90]), vm('stopped', [], { state: 'stopped', monthlyCostUsd: 200 })]);
    expect(recs.map((r) => r.ciId)).toEqual(['idle', 'small', 'stopped', 'hot']);
  });
});
