// T-473 REQ-BSM-005 REQ-BSM-003 (ADR-048) — a simulation's recommendations: the attached runbook leads, its estimate
// the sum of its step minutes; then each service predicted down recovers by its own procedure, and a service without
// redundancy groups is told to model them.
import { describe, expect, it } from 'vitest';
import type { ImpactSimulation } from '@openmap/contracts';
import { recommendationsFor } from './impact.service.js';

const SERVICE = '00000000-0000-4000-8000-0000000000a1';

const sim = {
  services: [
    {
      serviceCiId: SERVICE,
      name: 'Payments',
      tier: 1,
      predicted: 'down',
      path: [],
      usersAffected: null,
      revenueAtRiskPerHour: null,
      slaBudgetRemainingMinutes: null,
      recovery: { description: 'Promote the replica', estimatedMinutes: 20 },
    },
  ],
} as unknown as ImpactSimulation;

const runbook = {
  code: 'RB-DB-01',
  title: 'Database failover',
  ownerTeam: 'DBA',
  lastReviewedAt: null,
  steps: [
    { order: 1, instruction: 'Fail over', automation: null, estimatedMinutes: 10 },
    { order: 2, instruction: 'Verify', automation: null, estimatedMinutes: 5 },
  ],
};

describe('recommendationsFor', () => {
  it('leads with the attached runbook and its summed estimate', () => {
    const out = recommendationsFor(sim, new Map(), runbook);
    expect(out[0]).toEqual({ title: 'Follow runbook RB-DB-01: Database failover', rationale: '1. Fail over 2. Verify', estimatedMinutes: 15 });
    expect(out.slice(1).map((r) => r.title)).toEqual(['Recover Payments', 'Model redundancy for Payments']);
  });

  it('starts with the services when no runbook is attached', () => {
    expect(recommendationsFor(sim, new Map([[SERVICE, { groups: [{}] }]]))).toEqual([{ title: 'Recover Payments', rationale: 'Promote the replica', estimatedMinutes: 20 }]);
  });
});
