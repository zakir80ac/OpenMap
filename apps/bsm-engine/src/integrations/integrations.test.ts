// T-013 REQ-INT-005 REQ-INT-006 REQ-INT-007
import { describe, expect, it } from 'vitest';
import type { IntegrationConfig } from '@openmap/contracts';
import { deliver } from './delivery.js';
import { jiraProblem, pagerDutyEvent, priorityFor, resolutionFromRemote, serviceNowIncident, splunkHecEvent, type IncidentView } from './payloads.js';

const tenantId = '9b2c6a7e-0f6d-4c0b-9d7e-2a1f3b4c5d6e';
const config = (over: Partial<IntegrationConfig> = {}): IntegrationConfig => ({
  id: tenantId, tenantId, category: 'itsm', vendor: 'servicenow', name: 'SN', enabled: true, direction: 'bidirectional', endpoint: 'https://itsm.test/api/now/',
  credentialRef: 'openmap/itsm/snow', settings: { remoteIdPath: 'result.sys_id' }, fieldMappings: [], classMappings: [], subscribedEvents: [], schedule: null, createdAt: 'x', updatedAt: 'x', ...over,
});
const incident: IncidentView = {
  id: 'inc-1', tenantId, serviceName: 'Online banking', serviceTier: 1, state: 'down', openedAt: '2026-10-22T09:27:15.000Z', rootCauseName: 'pg-core-01', rootCauseCiId: 'ci-1',
  affectedCiIds: ['ci-1', 'ci-2'], alertCount: 11, usersAffected: 2_100_000, ownerTeams: ['Core banking platform'], summary: 'PDU trip took the ledger primary down.',
};

describe('payloads', () => {
  it('derives priority from tier and state', () => {
    expect(priorityFor(1, 'down')).toBe(1);
    expect(priorityFor(1, 'degraded')).toBe(2);
    expect(priorityFor(2, 'down')).toBe(2);
    expect(priorityFor(3, 'degraded')).toBe(3);
  });
  it('builds a ServiceNow incident with field mappings applied', () => {
    const p = serviceNowIncident(incident, config({ fieldMappings: [{ from: 'incident.ownerTeams', to: 'u_teams', direction: 'out' }] }));
    expect(p['priority']).toBe(1);
    expect(p['cmdb_ci']).toBe('pg-core-01');
    expect(p['u_teams']).toEqual(['Core banking platform']);
  });
  it('builds Jira, Splunk and PagerDuty payloads', () => {
    expect((jiraProblem(incident, config())['fields'] as Record<string, unknown>)['priority']).toEqual({ name: 'Highest' });
    const hec = splunkHecEvent(incident, config({ settings: { index: 'sec', sourcetype: 'om' } }));
    expect(hec['index']).toBe('sec');
    expect((hec['event'] as Record<string, unknown>)['alerts']).toBe(11);
    const pd = pagerDutyEvent(incident, config({ settings: { routingKey: 'rk' } }));
    expect(pd['dedup_key']).toBe('openmap-inc-1');
    expect((pd['payload'] as Record<string, unknown>)['severity']).toBe('critical');
  });
  it('reads resolution state back from remote systems', () => {
    expect(resolutionFromRemote('servicenow', { state: '6' })).toBe('resolved');
    expect(resolutionFromRemote('servicenow', { state: '2' })).toBe('open');
    expect(resolutionFromRemote('jira_service_management', { fields: { status: { name: 'Done' } } })).toBe('resolved');
  });
});

describe('delivery', () => {
  const deps = (responses: Array<{ status: number; body: unknown }>) => {
    const calls: string[] = [];
    let i = 0;
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return new Response(JSON.stringify(r.body), { status: r.status });
    };
    return { fetchImpl, sleep: async () => undefined, now: () => '2026-10-22T10:00:00.000Z', calls };
  };
  it('delivers, extracts the remote id and records the attempt', async () => {
    const d = deps([{ status: 201, body: { result: { sys_id: 'abc' } } }]);
    const out = await deliver({ config: config(), path: 'table/incident', method: 'POST', headers: {}, body: { a: 1 }, eventId: null }, d);
    expect(out.delivery.state).toBe('delivered');
    expect(out.remoteId).toBe('abc');
    expect(d.calls[0]).toBe('https://itsm.test/api/now/table/incident');
  });
  it('retries retryable statuses then dead-letters', async () => {
    const d = deps([{ status: 503, body: {} }]);
    const out = await deliver({ config: config(), path: 'x', method: 'POST', headers: {}, body: {}, eventId: null }, d);
    expect(out.delivery.state).toBe('dead_letter');
    expect(out.delivery.attempts).toBe(4);
  });
  it('fails fast on non-retryable errors', async () => {
    const d = deps([{ status: 401, body: {} }]);
    const out = await deliver({ config: config(), path: 'x', method: 'POST', headers: {}, body: {}, eventId: null }, d);
    expect(out.delivery.state).toBe('failed');
    expect(out.delivery.attempts).toBe(1);
  });
});
