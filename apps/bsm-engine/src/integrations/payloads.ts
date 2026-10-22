// REQ-INT-005 REQ-INT-006 — maps OpenMap incidents and impact simulations to ITSM and SIEM payloads.
// Pure mapping; delivery is in delivery.ts. Field mappings from the integration config are applied on top.
import { ITSM, TIME } from '@openmap/constants';
import type { ImpactSimulation, IntegrationConfig } from '@openmap/contracts';

export type ItsmPriority = typeof ITSM.priorityHighest | typeof ITSM.priorityHigh | typeof ITSM.priorityMedium;

export interface IncidentView {
  id: string;
  tenantId: string;
  serviceName: string;
  serviceTier: number;
  state: 'down' | 'degraded';
  openedAt: string;
  rootCauseName: string | null;
  rootCauseCiId: string | null;
  affectedCiIds: string[];
  alertCount: number;
  usersAffected: number | null;
  ownerTeams: string[];
  summary: string;
}

/** ITSM priority from service tier and state: tier-1 down is P1, tier-1 degraded or tier-2 down is P2, else P3. */
export function priorityFor(tier: number, state: IncidentView['state']): ItsmPriority {
  if (tier === ITSM.priorityHighest && state === 'down') return ITSM.priorityHighest;
  if (tier === ITSM.priorityHighest || state === 'down') return ITSM.priorityHigh;
  return ITSM.priorityMedium;
}

function applyMappings(base: Record<string, unknown>, source: Record<string, unknown>, config: IntegrationConfig): Record<string, unknown> {
  const out = { ...base };
  for (const m of config.fieldMappings) {
    if (m.direction !== 'out') continue;
    const value = m.from.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), source);
    if (value !== undefined) out[m.to] = value;
  }
  return out;
}

export function serviceNowIncident(incident: IncidentView, config: IntegrationConfig): Record<string, unknown> {
  const priority = priorityFor(incident.serviceTier, incident.state);
  const base = {
    short_description: '[OpenMap] ' + incident.serviceName + ' ' + incident.state.toUpperCase() + (incident.rootCauseName ? ' · root cause ' + incident.rootCauseName : ''),
    description: incident.summary,
    priority,
    impact: priority,
    urgency: priority,
    category: 'Infrastructure',
    cmdb_ci: incident.rootCauseName ?? incident.serviceName,
    business_service: incident.serviceName,
    assignment_group: incident.ownerTeams[0] ?? '',
    correlation_id: incident.id,
    u_openmap_affected_cis: incident.affectedCiIds.join(','),
    u_openmap_alerts: incident.alertCount,
  };
  return applyMappings(base, { incident }, config);
}

export function jiraProblem(incident: IncidentView, config: IntegrationConfig): Record<string, unknown> {
  const base = {
    fields: {
      summary: '[OpenMap] ' + incident.serviceName + ' ' + incident.state,
      description: incident.summary + '\n\nAffected CIs: ' + incident.affectedCiIds.join(', '),
      issuetype: { name: 'Problem' },
      priority: { name: ITSM.jiraPriorityNames[priorityFor(incident.serviceTier, incident.state)] },
      labels: ['openmap', 'incident-' + incident.id],
    },
  };
  return applyMappings(base, { incident }, config);
}

/** Splunk HTTP Event Collector envelope. `index` and `sourcetype` come from the integration settings. */
export function splunkHecEvent(incident: IncidentView, config: IntegrationConfig): Record<string, unknown> {
  const settings = config.settings;
  const base = {
    time: Math.floor(Date.parse(incident.openedAt) / TIME.msPerSecond),
    host: 'openmap',
    source: 'openmap:bsm',
    sourcetype: typeof settings['sourcetype'] === 'string' ? settings['sourcetype'] : 'openmap:incident',
    index: typeof settings['index'] === 'string' ? settings['index'] : 'openmap',
    event: {
      incidentId: incident.id,
      service: incident.serviceName,
      tier: incident.serviceTier,
      state: incident.state,
      rootCause: incident.rootCauseName,
      affectedCiIds: incident.affectedCiIds,
      usersAffected: incident.usersAffected,
      owners: incident.ownerTeams,
      alerts: incident.alertCount,
    },
  };
  return applyMappings(base, { incident }, config);
}

/** Microsoft Sentinel watchlist rows: one per at-risk or affected CI so analytics rules can prioritise them. */
export function sentinelWatchlistItems(simulation: ImpactSimulation, ciNames: ReadonlyMap<string, string>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const id of simulation.failedCiIds) rows.push({ CiId: id, Name: ciNames.get(id) ?? id, Role: 'failed', ScenarioId: simulation.scenarioId });
  for (const s of simulation.services) rows.push({ CiId: s.serviceCiId, Name: s.name, Role: 'service', Predicted: s.predicted, Tier: s.tier, ScenarioId: simulation.scenarioId });
  return rows;
}

export function pagerDutyEvent(incident: IncidentView, config: IntegrationConfig): Record<string, unknown> {
  const severity = priorityFor(incident.serviceTier, incident.state) === ITSM.priorityHighest ? 'critical' : incident.state === 'down' ? 'error' : 'warning';
  const base = {
    routing_key: typeof config.settings['routingKey'] === 'string' ? config.settings['routingKey'] : '',
    event_action: 'trigger',
    dedup_key: 'openmap-' + incident.id,
    payload: {
      summary: incident.serviceName + ' is ' + incident.state + (incident.rootCauseName ? ' (root cause ' + incident.rootCauseName + ')' : ''),
      source: 'openmap',
      severity,
      timestamp: incident.openedAt,
      component: incident.rootCauseName ?? incident.serviceName,
      group: incident.ownerTeams.join(', '),
      custom_details: { affectedCiIds: incident.affectedCiIds, usersAffected: incident.usersAffected, alerts: incident.alertCount },
    },
  };
  return applyMappings(base, { incident }, config);
}

export function resolutionFromRemote(vendor: IntegrationConfig['vendor'], remote: Record<string, unknown>): 'resolved' | 'open' | 'unknown' {
  if (vendor === 'servicenow') {
    const state = String(remote['state'] ?? '');
    return state === '6' || state === '7' || /resolved|closed/i.test(state) ? 'resolved' : state === '' ? 'unknown' : 'open';
  }
  if (vendor === 'jira_service_management') {
    const name = String((remote['fields'] as Record<string, unknown> | undefined)?.['status'] && ((remote['fields'] as Record<string, Record<string, unknown>>)['status']?.['name'] ?? ''));
    return /done|resolved|closed/i.test(name) ? 'resolved' : name === '' ? 'unknown' : 'open';
  }
  return 'unknown';
}
