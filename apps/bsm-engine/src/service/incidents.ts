// REQ-BSM-002 REQ-BSM-003 — incident lifecycle decisions from service state changes. Pure: given
// the services whose state changed and the incidents currently open for them, say which to open,
// which to update and which to resolve. Persistence and delivery happen in engine.ts.
import { ITSM } from '@openmap/constants';
import type { Health, ServiceState } from '../core/propagate.js';

export type IncidentSeverity = 'informational' | 'low' | 'medium' | 'high' | 'critical';

export interface OpenIncident {
  id: string;
  serviceCiId: string;
  severity: IncidentSeverity;
  rootCauseCiId: string | null;
}

export interface ServiceSummary {
  serviceCiId: string;
  name: string;
  tier: number;
}

export interface OpenAction {
  kind: 'open';
  serviceCiId: string;
  severity: IncidentSeverity;
  state: 'down' | 'degraded';
  rootCauseCiIds: string[];
  title: string;
  description: string;
}

export interface UpdateAction {
  kind: 'update';
  incidentId: string;
  severity: IncidentSeverity;
  rootCauseCiIds: string[];
}

export interface ResolveAction {
  kind: 'resolve';
  incidentId: string;
  serviceCiId: string;
}

/** The known cause cleared but the service is not yet observed healthy: the incident is mitigated, not resolved. */
export interface MitigateAction {
  kind: 'mitigate';
  incidentId: string;
  serviceCiId: string;
}

export type IncidentAction = OpenAction | UpdateAction | ResolveAction | MitigateAction;

/** Tier-1 down is critical, any down or tier-1 degraded is high, other degradation is medium. */
export function severityFor(tier: number, state: Health): IncidentSeverity {
  if (state === 'down' && tier === ITSM.priorityHighest) return 'critical';
  if (state === 'down' || tier === ITSM.priorityHighest) return 'high';
  return 'medium';
}

function describe(summary: ServiceSummary, state: ServiceState): string {
  const groups = state.groups.filter((g) => g.state !== 'healthy').map((g) => g.name + ' (' + g.state + ': ' + String(g.healthy) + '/' + String(g.memberCount) + ' healthy)');
  return summary.name + ' is ' + state.state + '. Affected redundancy groups: ' + (groups.length ? groups.join('; ') : 'none declared') + '.';
}

/** Decides incident actions for the changed services. Services returning to healthy resolve their open incident. */
export function incidentActions(changed: readonly ServiceState[], open: readonly OpenIncident[], summaries: ReadonlyMap<string, ServiceSummary>): IncidentAction[] {
  const actions: IncidentAction[] = [];
  const openByService = new Map(open.map((i) => [i.serviceCiId, i]));
  for (const state of changed) {
    const summary = summaries.get(state.serviceCiId) ?? { serviceCiId: state.serviceCiId, name: state.serviceCiId, tier: ITSM.priorityMedium };
    const existing = openByService.get(state.serviceCiId);
    if (state.state === 'down' || state.state === 'degraded') {
      const severity = severityFor(summary.tier, state.state);
      if (existing) {
        if (existing.severity !== severity || existing.rootCauseCiId !== (state.rootCauseCiIds[0] ?? null)) {
          actions.push({ kind: 'update', incidentId: existing.id, severity, rootCauseCiIds: state.rootCauseCiIds });
        }
      } else {
        actions.push({ kind: 'open', serviceCiId: state.serviceCiId, severity, state: state.state, rootCauseCiIds: state.rootCauseCiIds, title: summary.name + ' ' + state.state, description: describe(summary, state) });
      }
    } else if (existing && state.state === 'healthy') {
      actions.push({ kind: 'resolve', incidentId: existing.id, serviceCiId: state.serviceCiId });
    } else if (existing && state.state === 'unknown') {
      actions.push({ kind: 'mitigate', incidentId: existing.id, serviceCiId: state.serviceCiId });
    }
  }
  return actions;
}
