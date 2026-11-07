// T-467 REQ-BSM-004 (ADR-047) — the validation rules offline:
// - only down or degraded services count as predicted;
// - the person's own earlier simulation of the root cause is preferred to a replay;
// - a missed service is suggested unless the relationship exists or the service is the root cause itself;
// - an accepted or dismissed suggestion is never reopened by the repository;
// - list limits are bounded.
// The stores are stand-ins; T-466 runs the same flow on the compose stack.
import { describe, expect, it } from 'vitest';
import { IMPACT } from '@openmap/constants';
import type { ImpactSimulationView } from './impact.types.js';
import type { ImpactValidationRepository, IncidentToValidate, NewValidation } from './impact-validation.repository.js';
import { boundedLimit, ImpactValidationService, predictedServiceIds } from './impact-validation.service.js';

const ROOT = '00000000-0000-4000-8000-000000000001';
const S1 = '00000000-0000-4000-8000-0000000000a1';
const S2 = '00000000-0000-4000-8000-0000000000a2';
const S3 = '00000000-0000-4000-8000-0000000000a3';
const PRIOR = '00000000-0000-4000-8000-0000000000f1';

function sim(id: string, states: Array<[string, 'down' | 'degraded' | 'at_risk' | 'unaffected']>): ImpactSimulationView {
  return {
    id,
    scenarioId: id,
    ranAt: '2026-11-01T00:00:00.000Z',
    durationMs: 1,
    failedCiIds: [ROOT],
    affectedApplicationCiIds: [],
    services: states.map(([sid, predicted]) => ({ service: { id: sid } as never, tier: 1, predicted, path: [], usersAffected: null, revenueAtRiskPerHour: null, slaBudgetRemainingMinutes: null, recovery: null })),
    totals: { servicesDown: 0, servicesDegraded: 0, usersAffected: 0, revenueAtRiskPerHour: null },
    recommendations: [],
  };
}

const incident: IncidentToValidate = { id: '00000000-0000-4000-8000-0000000000e1', tenantId: '00000000-0000-4000-8000-0000000000b1', title: 'Payments down', rootCauseCiId: ROOT, affectedServiceCiIds: [S1, S3, ROOT], openedAt: '2026-11-02T00:00:00.000Z' };

function harness(options: { prior: string | null; existing: string[] }) {
  const saved: NewValidation[] = [];
  const suggested: Array<[string, string]> = [];
  const replays: string[] = [];
  const repo: Partial<ImpactValidationRepository> = {
    incident: () => Promise.resolve(incident),
    priorSimulationId: () => Promise.resolve(options.prior),
    existingPairs: (_t, _type, _from, to) => Promise.resolve(new Set(to.filter((id) => options.existing.includes(id)))),
    saveValidation: (_tx, v) => {
      saved.push(v);
      return Promise.resolve({ id: 'v', ...v });
    },
    suggest: (_tx, _t, _type, from, to) => {
      suggested.push([from, to]);
      return Promise.resolve();
    },
  };
  const scenarios = { saveScenario: () => Promise.resolve({ id: 'replay' }) };
  const impact = {
    simulation: (_t: string, id: string) => Promise.resolve(id === PRIOR ? sim(PRIOR, [[S1, 'down'], [S2, 'degraded'], [S3, 'at_risk']]) : null),
    runSimulation: () => {
      replays.push('run');
      return Promise.resolve(sim('replay', [[S1, 'down']]));
    },
  };
  const outbox = { transaction: <T>(_t: string, fn: (ctx: { tx: unknown; emit: () => Promise<void> }) => Promise<T>) => fn({ tx: {}, emit: () => Promise.resolve() }) };
  const metrics = { impactValidations: { inc: () => undefined }, impactAccuracy: { observe: () => undefined } };
  const service = new ImpactValidationService(
    repo as ImpactValidationRepository,
    scenarios as never,
    impact as never,
    {} as never,
    outbox as never,
    metrics as never,
    { IMPACT_VALIDATION_INTERVAL_MS: 0 } as never,
  );
  return { service, saved, suggested, replays };
}

describe('impact validation rules', () => {
  it('counts only down or degraded services as predicted', () => {
    expect(predictedServiceIds(sim('x', [[S1, 'down'], [S2, 'degraded'], [S3, 'at_risk'], [ROOT, 'unaffected'], [S1, 'degraded']]))).toEqual([S1, S2]);
  });

  it("prefers the person's earlier simulation and suggests each new miss once", async () => {
    const h = harness({ prior: PRIOR, existing: [] });
    const v = await h.service.validateIncident(incident.tenantId, incident.id);
    expect(h.replays).toEqual([]);
    expect(v.simulationId).toBe(PRIOR);
    // Predicted S1, S2; the incident hit S1, S3 and named the root cause itself among the services.
    expect(v.predictedServiceCiIds).toEqual([S1, S2]);
    expect(v.missedServiceCiIds).toEqual([ROOT, S3].sort());
    expect(v.unexpectedServiceCiIds).toEqual([S2]);
    expect(v.accuracy).toBeCloseTo(1 / 4);
    // The root cause is never suggested as part of a service of itself.
    expect(h.suggested).toEqual([[ROOT, S3]]);
  });

  it('replays the root cause when nobody simulated it, and skips a relationship that exists', async () => {
    const h = harness({ prior: null, existing: [S3] });
    const v = await h.service.validateIncident(incident.tenantId, incident.id);
    expect(h.replays).toEqual(['run']);
    expect(v.simulationId).toBe('replay');
    expect(h.suggested).toEqual([]);
  });

  it('bounds list limits', () => {
    expect(boundedLimit(null, IMPACT.recentDefault)).toBe(IMPACT.recentDefault);
    expect(boundedLimit(0, IMPACT.recentDefault)).toBe(1);
    expect(boundedLimit(IMPACT.listMax * 10, IMPACT.recentDefault)).toBe(IMPACT.listMax);
  });
});
