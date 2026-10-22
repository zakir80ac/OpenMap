// REQ-BSM-002 REQ-INT-005 — maps an incident to the vendor payload and API route. Routes are the
// vendors' fixed API paths, identical for every deployment; the host comes from the integration.
import { jiraProblem, pagerDutyEvent, serviceNowIncident, splunkHecEvent, type IncidentView } from '@openmap/bsm-engine';
import type { IntegrationConfig } from '@openmap/contracts';

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
