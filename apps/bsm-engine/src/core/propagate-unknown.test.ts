// T-052 REQ-BSM-002 — unobserved members leave a group unknown; only a member known to be down takes it down.
import { describe, expect, it } from 'vitest';
import { groupState, propagate } from './propagate.js';

describe('groupState with unknown members', () => {
  const group = { name: 'app', memberCiIds: ['a', 'b'], minHealthy: 1 };

  it('is unknown when nothing has been observed', () => {
    expect(groupState(group, new Map()).state).toBe('unknown');
  });

  it('is down when a member is down and nothing else serves', () => {
    expect(groupState(group, new Map([['a', 'down'], ['b', 'unknown']])).state).toBe('down');
  });

  it('is healthy when enough members serve even if others are unknown', () => {
    expect(groupState(group, new Map([['a', 'healthy']])).state).toBe('degraded');
    expect(groupState({ ...group, minHealthy: 1, memberCiIds: ['a'] }, new Map([['a', 'healthy']])).state).toBe('healthy');
  });

  it('propagates unknown without naming root causes', () => {
    const state = propagate({ serviceCiId: 's', groups: [group] }, new Map());
    expect(state.state).toBe('unknown');
    expect(state.rootCauseCiIds).toEqual(['a', 'b']);
  });
});
