// T-472 REQ-BSM-005 (ADR-048) — a runbook step's automation request per vendor:
// - AWX launches the job template named by the action, with the incident as `openmap_` extra vars;
// - XSOAR creates an incident that runs the playbook, with OpenMap's severity on XSOAR's scale;
// - any other vendor receives the action, the incident and the step at its endpoint;
// - XSOAR's API key travels as the raw Authorization value.
import { describe, expect, it } from 'vitest';
import type { IntegrationConfig } from '@openmap/contracts';
import { authHeaders, automationRequest, type AutomationContext } from './routes.js';

const config = (vendor: IntegrationConfig['vendor']): IntegrationConfig => ({
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  category: vendor === 'cortex_xsoar' ? 'soar' : 'automation',
  vendor,
  name: vendor,
  enabled: true,
  direction: 'outbound',
  endpoint: 'https://automation.example.test/',
  credentialRef: 'automation/' + vendor,
  settings: {},
  fieldMappings: [],
  classMappings: [],
  subscribedEvents: [],
  schedule: null,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
});

const ctx: AutomationContext = {
  incidentId: '00000000-0000-4000-8000-0000000000aa',
  title: 'Payments down',
  severity: 'critical',
  rootCause: 'db-ryd-pg-core-01',
  services: ['Payments'],
  step: { order: 1, instruction: 'Fail over the database' },
  runbookCode: 'RB-DB-01',
};

describe('automationRequest', () => {
  it('launches an AWX job template with the incident as extra vars', () => {
    const r = automationRequest('42', ctx, config('ansible_awx'));
    expect(r).toMatchObject({ method: 'POST', path: 'api/v2/job_templates/42/launch/' });
    expect(r.body['extra_vars']).toEqual({
      openmap_incident_id: ctx.incidentId,
      openmap_incident_title: 'Payments down',
      openmap_severity: 'critical',
      openmap_root_cause: 'db-ryd-pg-core-01',
      openmap_services: ['Payments'],
      openmap_runbook: 'RB-DB-01',
      openmap_step: 1,
    });
    // A template name is escaped into the path.
    expect(automationRequest('db failover', ctx, config('ansible_awx')).path).toBe('api/v2/job_templates/db%20failover/launch/');
  });

  it('runs an XSOAR playbook through a new incident', () => {
    const r = automationRequest('DB Failover', ctx, config('cortex_xsoar'));
    expect(r).toMatchObject({ method: 'POST', path: 'incident' });
    expect(r.body).toMatchObject({ name: 'Payments down', severity: 4, playbookId: 'DB Failover', createInvestigation: true, details: 'Fail over the database' });
    expect(authHeaders('cortex_xsoar', { token: 'k' })['authorization']).toBe('k');
  });

  it('posts the action, incident and step to any other automation endpoint', () => {
    const r = automationRequest('restart', ctx, config('saltstack'));
    expect(r).toEqual({ path: '', method: 'POST', body: { action: 'restart', incident: ctx, step: ctx.step } });
  });
});
