// REQ-INT-005 REQ-INT-007 — maps an incident to each vendor's payload, API route and auth header.
// Routes are the vendors' fixed API paths, identical for every deployment; the host comes from the
// integration's endpoint and the credential from OpenBao via the caller.
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
    default:
      if (user && (password || token)) headers['authorization'] = 'Basic ' + Buffer.from(user + ':' + (password || token)).toString('base64');
      else if (token) headers['authorization'] = 'Bearer ' + token;
      return headers;
  }
}
