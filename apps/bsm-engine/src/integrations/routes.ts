// REQ-INT-005 REQ-INT-007 REQ-BSM-005 — maps an incident to each vendor's payload, API route and auth header, and a
// runbook step's automation to the SOAR or automation vendor's request (ADR-048).
// Routes are the vendors' fixed API paths, identical for every deployment; the host comes from the
// integration's endpoint and the credential from OpenBao via the caller.
import { RUNBOOKS } from '@openmap/constants';
import type { IntegrationConfig } from '@openmap/contracts';
import { jiraProblem, pagerDutyEvent, serviceNowIncident, splunkHecEvent, type IncidentView } from './payloads.js';

export interface OutboundRequest {
  path: string;
  method: 'POST' | 'PUT' | 'PATCH';
  body: Record<string, unknown>;
}

const ROUTES = {
  servicenow: 'api/now/table/incident',
  jira_service_management: 'rest/api/2/issue',
  splunk: 'services/collector/event',
  pagerduty: 'v2/enqueue',
} as const;

export function incidentRequest(incident: IncidentView, config: IntegrationConfig): OutboundRequest {
  switch (config.vendor) {
    case 'servicenow':
      return { path: ROUTES.servicenow, method: 'POST', body: serviceNowIncident(incident, config) };
    case 'jira_service_management':
      return { path: ROUTES.jira_service_management, method: 'POST', body: jiraProblem(incident, config) };
    case 'splunk':
      return { path: ROUTES.splunk, method: 'POST', body: splunkHecEvent(incident, config) };
    case 'pagerduty':
      return { path: ROUTES.pagerduty, method: 'POST', body: pagerDutyEvent(incident, config) };
    default:
      // Generic webhook-style adapters receive the incident view as-is at the configured endpoint.
      return { path: '', method: 'POST', body: { incident } };
  }
}

/** Remote record URL from the optional `remoteUrlTemplate` setting: the remote console path with a `{remoteId}` token. */
export function remoteUrlFor(config: IntegrationConfig, remoteId: string): string | null {
  const template = config.settings['remoteUrlTemplate'];
  if (typeof template !== 'string' || template.length === 0) return null;
  return template.split('{remoteId}').join(encodeURIComponent(remoteId));
}

/** Authentication headers from a resolved credential's fields, per vendor convention. */
export function authHeaders(vendor: IntegrationConfig['vendor'], fields: Readonly<Record<string, string>>): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const token = fields['token'] ?? fields['apiToken'] ?? '';
  const user = fields['username'] ?? '';
  const password = fields['password'] ?? '';
  switch (vendor) {
    case 'splunk':
      if (token) headers['authorization'] = 'Splunk ' + token;
      return headers;
    case 'pagerduty':
      // Events API v2 authenticates with the routing key inside the payload; the REST token is optional.
      if (token) headers['authorization'] = 'Token token=' + token;
      return headers;
    case 'cortex_xsoar':
      // XSOAR takes the API key as the raw Authorization value (ADR-048).
      if (token) headers['authorization'] = token;
      return headers;
    default:
      if (user && (password || token)) headers['authorization'] = 'Basic ' + Buffer.from(user + ':' + (password || token)).toString('base64');
      else if (token) headers['authorization'] = 'Bearer ' + token;
      return headers;
  }
}

/** What a runbook step's automation is told about the incident it runs for. */
export interface AutomationContext {
  incidentId: string;
  title: string;
  severity: keyof typeof RUNBOOKS.xsoarSeverity;
  rootCause: string | null;
  services: string[];
  step: { order: number; instruction: string };
  runbookCode: string;
}

/**
 * The request that runs `action` on the integration (ADR-048): an AWX job-template launch with the incident as extra
 * vars, an XSOAR incident that runs the playbook, or for any other vendor a POST of the action and the incident to
 * the configured endpoint.
 */
export function automationRequest(action: string, ctx: AutomationContext, config: IntegrationConfig): OutboundRequest {
  const vars: Record<string, unknown> = {
    [RUNBOOKS.extraVarsPrefix + 'incident_id']: ctx.incidentId,
    [RUNBOOKS.extraVarsPrefix + 'incident_title']: ctx.title,
    [RUNBOOKS.extraVarsPrefix + 'severity']: ctx.severity,
    [RUNBOOKS.extraVarsPrefix + 'root_cause']: ctx.rootCause,
    [RUNBOOKS.extraVarsPrefix + 'services']: ctx.services,
    [RUNBOOKS.extraVarsPrefix + 'runbook']: ctx.runbookCode,
    [RUNBOOKS.extraVarsPrefix + 'step']: ctx.step.order,
  };
  switch (config.vendor) {
    case 'ansible_awx':
      return { path: RUNBOOKS.awxLaunchPath.replace(RUNBOOKS.actionToken, encodeURIComponent(action)), method: 'POST', body: { extra_vars: vars } };
    case 'cortex_xsoar':
      return {
        path: RUNBOOKS.xsoarIncidentPath,
        method: 'POST',
        body: {
          name: ctx.title,
          severity: RUNBOOKS.xsoarSeverity[ctx.severity],
          details: ctx.step.instruction,
          playbookId: action,
          createInvestigation: true,
          CustomFields: vars,
        },
      };
    default:
      return { path: '', method: 'POST', body: { action, incident: ctx, step: ctx.step } };
  }
}
