// T-465 REQ-BSM-004 (ADR-047) — prediction accuracy: predicted and actual services compare by Jaccard similarity, the
// services the model missed and the ones it over-predicted are named, and the suggestion and validation shapes parse.
import { describe, expect, it } from 'vitest';
import { compareImpact, impactValidationSchema, relationshipSuggestionSchema, scenarioOriginSchema } from './impact.js';

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
