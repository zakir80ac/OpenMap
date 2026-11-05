// T-133 REQ-BSM-006 — SLA decisions: breach incidents, at-risk alerts, window roll-over, response and resolution targets.
import { SLA } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { availabilityIn, windowBudget } from '../core/availability.js';
import {
  breachSeverity,
  slaActions,
  targetBreaches,
  targetsFor,
  type SlaDefinition,
  type SlaServiceInput,
} from './sla.js';

const sla: SlaDefinition = {
  id: 'sla-1',
  name: 'Gold',
  availabilityTargetPercent: 99.9,
  window: 'calendar_month',
  responseTargets: { critical: { respondMinutes: 10, resolveMinutes: 60 } },
  burnRateAlert: 2,
};
const window = { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' };

function input(downMinutes: number, now: string, overrides: Partial<SlaServiceInput> = {}): SlaServiceInput {
  const changes =
    downMinutes === 0
      ? []
      : [
          { at: '2026-10-02T00:00:00.000Z', state: 'down' as const },
          {
            at: new Date(Date.parse('2026-10-02T00:00:00.000Z') + downMinutes * 60_000).toISOString(),
            state: 'healthy' as const,
          },
        ];
  const figures = availabilityIn(changes, 'healthy', window, now);
  return {
    serviceCiId: 'svc',
    name: 'Online banking',
    tier: 1,
    sla,
    window,
    figures,
    budget: windowBudget(sla.availabilityTargetPercent, window, figures, now),
    openIncident: null,
    atRiskRaised: false,
    ...overrides,
  };
}

describe('slaActions', () => {
  it('opens a breach incident once the budget is exhausted and not again while it is open', () => {
    const now = '2026-10-03T00:00:00.000Z';
    const actions = slaActions([input(60, now)], now);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'breach',
      serviceCiId: 'svc',
      slaId: 'sla-1',
      severity: 'critical',
      title: 'Online banking SLA breached',
    });
    expect(
      slaActions(
        [input(60, now, { openIncident: { id: 'inc', openedAt: '2026-10-02T01:00:00.000Z' } })],
        now,
      ),
    ).toEqual([]);
  });

  it('raises one at-risk alert when the burn rate crosses the threshold with budget left', () => {
    // 44.64 min budget over October; 10 minutes down two days in burns at 10 / (44.64 × 2/31) ≈ 3.5.
    const now = '2026-10-03T00:00:00.000Z';
    const [action] = slaActions([input(10, now)], now);
    expect(action).toMatchObject({ kind: 'at_risk', serviceCiId: 'svc', slaId: 'sla-1' });
    if (action?.kind !== 'at_risk') throw new Error('expected at_risk');
    expect(action.burnRate).toBeGreaterThan(2);
    expect(Date.parse(action.forecastAt)).toBeGreaterThan(Date.parse(now));
    expect(slaActions([input(10, now, { atRiskRaised: true })], now)).toEqual([]);
    // Burning under the threshold raises nothing.
    expect(slaActions([input(1, '2026-10-30T00:00:00.000Z')], '2026-10-30T00:00:00.000Z')).toEqual([]);
  });

  it('closes a breach incident from a previous window once the new window is within budget', () => {
    const now = '2026-10-03T00:00:00.000Z';
    const actions = slaActions(
      [input(0, now, { openIncident: { id: 'old', openedAt: '2026-09-20T00:00:00.000Z' } })],
      now,
    );
    expect(actions).toEqual([{ kind: 'clear', incidentId: 'old', serviceCiId: 'svc' }]);
  });

  it('grades a breach by tier', () => {
    expect(breachSeverity(1)).toBe('critical');
    expect(breachSeverity(2)).toBe('high');
    expect(breachSeverity(3)).toBe('high');
  });
});

describe('targets', () => {
  it('derives deadlines from the SLA where it names the severity and from the defaults elsewhere', () => {
    expect(targetsFor(sla, 'critical', '2026-10-01T00:00:00.000Z')).toEqual({
      respondBy: '2026-10-01T00:10:00.000Z',
      resolveBy: '2026-10-01T01:00:00.000Z',
    });
    const high = targetsFor(sla, 'high', '2026-10-01T00:00:00.000Z');
    expect(Date.parse(high.respondBy) - Date.parse('2026-10-01T00:00:00.000Z')).toBe(
      SLA.defaultTargets.high.respondMinutes * 60_000,
    );
    expect(targetsFor(null, 'medium', '2026-10-01T00:00:00.000Z').resolveBy).toBe(
      new Date(
        Date.parse('2026-10-01T00:00:00.000Z') + SLA.defaultTargets.medium.resolveMinutes * 60_000,
      ).toISOString(),
    );
  });

  it('reports missed targets once, never for resolved incidents, and not for acknowledged responses', () => {
    const base = {
      acknowledgedAt: null,
      resolvedAt: null,
      respondBy: '2026-10-01T00:10:00.000Z',
      resolveBy: '2026-10-01T01:00:00.000Z',
      responseBreachedAt: null,
      resolutionBreachedAt: null,
    };
    expect(targetBreaches([{ id: 'a', ...base }], '2026-10-01T00:05:00.000Z')).toEqual([]);
    expect(targetBreaches([{ id: 'a', ...base }], '2026-10-01T00:10:00.000Z')).toEqual([
      { incidentId: 'a', kind: 'response' },
    ]);
    expect(
      targetBreaches(
        [{ id: 'a', ...base, acknowledgedAt: '2026-10-01T00:04:00.000Z' }],
        '2026-10-01T02:00:00.000Z',
      ),
    ).toEqual([{ incidentId: 'a', kind: 'resolution' }]);
    expect(
      targetBreaches(
        [{ id: 'a', ...base, responseBreachedAt: '2026-10-01T00:10:00.000Z' }],
        '2026-10-01T02:00:00.000Z',
      ),
    ).toEqual([{ incidentId: 'a', kind: 'resolution' }]);
    expect(
      targetBreaches(
        [{ id: 'a', ...base, resolvedAt: '2026-10-01T00:30:00.000Z' }],
        '2026-10-01T02:00:00.000Z',
      ),
    ).toEqual([]);
    expect(
      targetBreaches([{ id: 'a', ...base, respondBy: null, resolveBy: null }], '2026-10-01T02:00:00.000Z'),
    ).toEqual([]);
  });
});
