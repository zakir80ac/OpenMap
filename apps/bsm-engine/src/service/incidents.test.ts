// T-051 REQ-BSM-002 — incident actions: open on degradation, update on severity or root-cause change, resolve on recovery, never duplicate.
import { describe, expect, it } from 'vitest';
import type { ServiceState } from '../core/propagate.js';
import { incidentActions, severityFor } from './incidents.js';

function state(serviceCiId: string, s: ServiceState['state'], roots: string[] = []): ServiceState {
  return { serviceCiId, state: s, groups: [{ name: 'db', state: s, healthy: 0, degraded: 0, down: 1, unknown: 0, minHealthy: 1, memberCount: 2 }], rootCauseCiIds: roots };
}

describe('incidentActions', () => {
  const summaries = new Map([
    ['svc-1', { serviceCiId: 'svc-1', name: 'Online banking', tier: 1 }],
    ['svc-2', { serviceCiId: 'svc-2', name: 'Intranet', tier: 3 }],
  ]);

  it('opens with severity from tier and state', () => {
    const actions = incidentActions([state('svc-1', 'down', ['db-1']), state('svc-2', 'degraded', ['web-2'])], [], summaries);
    expect(actions.map((a) => a.kind)).toEqual(['open', 'open']);
    expect(actions[0]).toMatchObject({ severity: 'critical', title: 'Online banking down', rootCauseCiIds: ['db-1'] });
    expect(actions[1]).toMatchObject({ severity: 'medium', title: 'Intranet degraded' });
  });

  it('updates an open incident only when severity or root cause moves', () => {
    const open = [{ id: 'inc-1', serviceCiId: 'svc-1', severity: 'high' as const, rootCauseCiId: 'db-1' }];
    expect(incidentActions([state('svc-1', 'down', ['db-1'])], open, summaries)).toEqual([{ kind: 'update', incidentId: 'inc-1', severity: 'critical', rootCauseCiIds: ['db-1'] }]);
    expect(incidentActions([state('svc-1', 'degraded', ['db-1'])], open, summaries)).toEqual([]);
  });

  it('resolves when the service is healthy again and mitigates when it becomes unknown', () => {
    const open = [{ id: 'inc-1', serviceCiId: 'svc-1', severity: 'high' as const, rootCauseCiId: null }];
    expect(incidentActions([state('svc-1', 'healthy')], open, summaries)).toEqual([{ kind: 'resolve', incidentId: 'inc-1', serviceCiId: 'svc-1' }]);
    expect(incidentActions([state('svc-1', 'unknown')], open, summaries)).toEqual([{ kind: 'mitigate', incidentId: 'inc-1', serviceCiId: 'svc-1' }]);
    expect(incidentActions([state('svc-1', 'unknown')], [], summaries)).toEqual([]);
  });

  it('grades severity', () => {
    expect(severityFor(1, 'down')).toBe('critical');
    expect(severityFor(2, 'down')).toBe('high');
    expect(severityFor(1, 'degraded')).toBe('high');
    expect(severityFor(3, 'degraded')).toBe('medium');
  });
});
