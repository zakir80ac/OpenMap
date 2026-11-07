// T-465 REQ-BSM-004 (ADR-047) — prediction accuracy: predicted and actual services compare by Jaccard similarity, the
// services the model missed and the ones it over-predicted are named, and the suggestion and validation shapes parse.
// T-470 REQ-BSM-005 (ADR-048) — a runbook's recovery estimate sums its steps' minutes, and the minutes still to go
// leave out the steps whose latest run is done or triggered.
import { describe, expect, it } from 'vitest';
import { compareImpact, impactValidationSchema, relationshipSuggestionSchema, remainingRunbookMinutes, runbookMinutes, scenarioOriginSchema } from './impact.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const now = '2026-11-08T00:00:00.000Z';

describe('compareImpact', () => {
  it('scores an exact prediction 1 and two empty sets as agreeing', () => {
    expect(compareImpact([A, B], [B, A])).toEqual({ accuracy: 1, missed: [], unexpected: [] });
    expect(compareImpact([], [])).toEqual({ accuracy: 1, missed: [], unexpected: [] });
  });
  it('names what the model missed and what it over-predicted', () => {
    // Predicted A and B, the incident hit B and C: one of three services agrees.
    const r = compareImpact([A, B], [B, C]);
    expect(r.accuracy).toBeCloseTo(1 / 3);
    expect(r.missed).toEqual([C]);
    expect(r.unexpected).toEqual([A]);
    expect(compareImpact([], [A]).accuracy).toBe(0);
    expect(compareImpact([A, A], [A]).accuracy).toBe(1);
  });
});

describe('validation and suggestion shapes', () => {
  it('parse representative records and reject an unknown origin', () => {
    expect(
      impactValidationSchema.safeParse({ simulationId: A, incidentId: B, predictedServiceCiIds: [A], actualServiceCiIds: [A, C], accuracy: 0.5, missedServiceCiIds: [C], validatedAt: now }).success,
    ).toBe(true);
    expect(
      relationshipSuggestionSchema.safeParse({
        id: A,
        tenantId: B,
        type: 'part_of_service',
        fromCiId: A,
        toCiId: C,
        reason: 'impact_miss',
        occurrences: 2,
        lastIncidentId: B,
        state: 'open',
        decidedBy: null,
        decidedAt: null,
        relationshipId: null,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(true);
    expect(scenarioOriginSchema.safeParse('incident').success).toBe(true);
    expect(scenarioOriginSchema.safeParse('import').success).toBe(false);
  });
});

describe('runbook estimates (T-470)', () => {
  const step = (order: number, estimatedMinutes: number | null) => ({ order, instruction: 'step ' + String(order), automation: null, estimatedMinutes });
  const runbook = { steps: [step(1, 5), step(2, 20), step(3, null), step(4, 10)] };
  it('sums the step minutes and is null without any estimate', () => {
    expect(runbookMinutes(runbook)).toBe(35);
    expect(runbookMinutes({ steps: [step(1, null)] })).toBeNull();
    expect(remainingRunbookMinutes({ steps: [step(1, null)] }, [])).toBeNull();
  });
  it("counts what is left by each step's latest run", () => {
    expect(remainingRunbookMinutes(runbook, [])).toBe(35);
    const runs = [
      { order: 1, outcome: 'done' as const, at: '2026-11-08T00:00:00.000Z' },
      { order: 2, outcome: 'triggered' as const, at: '2026-11-08T00:01:00.000Z' },
      // Step 4 failed after it was triggered: it is still to do.
      { order: 4, outcome: 'triggered' as const, at: '2026-11-08T00:02:00.000Z' },
      { order: 4, outcome: 'failed' as const, at: '2026-11-08T00:03:00.000Z' },
    ];
    expect(remainingRunbookMinutes(runbook, runs)).toBe(10);
  });
});
