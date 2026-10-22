// T-009 REQ-BSM-002 REQ-BSM-003
import { describe, expect, it } from 'vitest';
import type { ImpactScenario } from '@openmap/contracts';
import type { GraphRepository, ImpactNode, ImpactResult } from '@openmap/graph';
import { groupState, propagate, propagateAll, type Health, type ServiceModel } from './propagate.js';
import { slaStatus } from './sla.js';
import { simulate, type ServiceFacts } from './simulate.js';

const h = (entries: Array<[string, Health]>) => new Map<string, Health>(entries);

describe('propagation', () => {
  const pair = { name: 'db', memberCiIds: ['pg1', 'pg2'], minHealthy: 1 };
  it('an active/standby pair with one member down is degraded, both down is down', () => {
    expect(groupState(pair, h([['pg1', 'down'], ['pg2', 'healthy']])).state).toBe('degraded');
    expect(groupState(pair, h([['pg1', 'down'], ['pg2', 'down']])).state).toBe('down');
    expect(groupState(pair, h([['pg1', 'healthy'], ['pg2', 'healthy']])).state).toBe('healthy');
  });
  it('an N-of-M group below minimum is down', () => {
    const g = { name: 'web', memberCiIds: ['a', 'b', 'c', 'd'], minHealthy: 3 };
    expect(groupState(g, h([['a', 'down'], ['b', 'down'], ['c', 'healthy'], ['d', 'healthy']])).state).toBe('down');
    expect(groupState(g, h([['a', 'down'], ['b', 'healthy'], ['c', 'healthy'], ['d', 'healthy']])).state).toBe('degraded');
  });
  it('service takes the worst group and names root causes', () => {
    const model: ServiceModel = { serviceCiId: 'banking', groups: [pair, { name: 'auth', memberCiIds: ['kc'], minHealthy: 1 }] };
    const s = propagate(model, h([['pg1', 'down'], ['pg2', 'down'], ['kc', 'healthy']]));
    expect(s.state).toBe('down');
    expect(s.rootCauseCiIds).toEqual(['pg1', 'pg2']);
    const all = propagateAll([model], h([['pg1', 'healthy'], ['pg2', 'healthy'], ['kc', 'healthy']]), new Map([['banking', 'down']]));
    expect(all.changed.map((c) => c.state)).toEqual(['healthy']);
  });
});

describe('sla', () => {
  it('computes budget, burn rate and breach forecast for 99.95% over 30 days', () => {
    const s = slaStatus({ targetPercent: 99.95, periodStart: '2026-10-01T00:00:00Z', downtimeMinutes: 17, now: '2026-10-22T00:00:00Z' });
    expect(s.budgetMinutes).toBeCloseTo(21.6, 1);
    expect(s.remainingMinutes).toBeCloseTo(4.6, 1);
    expect(s.burnRate).toBeGreaterThan(1);
    expect(s.breachForecast).not.toBeNull();
    expect(s.breached).toBe(false);
  });
});

describe('simulate', () => {
  const tenantId = '9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
  const node = (id: string, type: ImpactNode['ci']['type'], depth: number, path: string[]): ImpactNode => ({
    ci: { id, tenantId, type, layer: 'applications', name: id, displayName: id, lifecycle: 'managed', health: 'healthy', tier: type === 'business_service' ? 1 : null, validFrom: '2026-01-01T00:00:00Z', validTo: null },
    depth,
    path,
  });
  const impact: ImpactResult = {
    rootId: 'pdu',
    nodes: [node('pg1', 'host', 1, ['pdu', 'pg1']), node('ledger', 'application', 2, ['pdu', 'pg1', 'ledger']), node('banking', 'business_service', 3, ['pdu', 'pg1', 'ledger', 'banking'])],
    services: [node('banking', 'business_service', 3, ['pdu', 'pg1', 'ledger', 'banking'])],
    durationMs: 1,
  };
  const repo = { impact: async () => impact } as unknown as GraphRepository;
  const scenario: ImpactScenario = { id: tenantId, tenantId, name: 'pdu', kind: 'power', failedCiIds: ['pdu', 'pg1'], options: { maxDepth: 0, honourRedundancy: true, includeSharedServices: true, at: null }, createdBy: 'syed', createdAt: '2026-10-22T00:00:00Z', changeRef: null };
  const facts = new Map<string, ServiceFacts>([['banking', { serviceCiId: 'banking', name: 'Online banking', tier: 1, usersAffected: 2_100_000, revenuePerHour: { amount: 1_400_000, currency: 'SAR' }, sla: null, recovery: null }]]);
  const models = new Map<string, ServiceModel>([['banking', { serviceCiId: 'banking', groups: [{ name: 'db', memberCiIds: ['pg1', 'pg2'], minHealthy: 1 }] }]]);

  it('honours redundancy: the replica keeps the service degraded rather than down', async () => {
    const sim = await simulate(repo, { scenario, severity: 'down', health: h([['pg1', 'healthy'], ['pg2', 'healthy']]), models, facts, outageMinutes: 30 });
    expect(sim.services[0]?.predicted).toBe('degraded');
    expect(sim.totals.servicesDegraded).toBe(1);
    expect(sim.totals.revenueAtRiskPerHour?.amount).toBe(420_000);
  });
  it('without redundancy the whole closure fails', async () => {
    const sim = await simulate(repo, { scenario: { ...scenario, options: { ...scenario.options, honourRedundancy: false } }, severity: 'down', health: h([['pg1', 'healthy'], ['pg2', 'healthy']]), models, facts, outageMinutes: 30 });
    expect(sim.services[0]?.predicted).toBe('down');
    expect(sim.totals.usersAffected).toBe(2_100_000);
  });
  it('at-risk conditions change nothing today but flag every reached service', async () => {
    const sim = await simulate(repo, { scenario, severity: 'at_risk', health: h([['pg1', 'healthy'], ['pg2', 'healthy']]), models, facts, outageMinutes: 0 });
    expect(sim.services[0]?.predicted).toBe('at_risk');
    expect(sim.totals.servicesDown).toBe(0);
  });
});
