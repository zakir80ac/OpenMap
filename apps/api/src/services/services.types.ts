// REQ-BSM-002 — view types for ServiceHealth, Incident and IncidentLink.
import type { CiRecord, HealthState } from '../ci/ci.types.js';

export interface ServiceHealthView {
  service: CiRecord;
  state: HealthState;
  since: string;
  rootCauses: CiRecord[];
  slaTarget: number;
  errorBudgetRemainingMinutes: number;
}

export interface IncidentRecord {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  state: 'open' | 'acknowledged' | 'mitigated' | 'resolved' | 'closed';
  serviceCiId: string | null;
  affectedServiceCiIds: string[];
  rootCauseCiId: string | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  /** Alerts correlated into the incident. */
  alerts: number;
}

export interface IncidentLinkRecord {
  incidentId: string;
  integrationId: string;
  remoteId: string;
  remoteUrl: string | null;
  remoteState: string;
  syncedAt: string;
}

export interface HealthEvent {
  subject: string;
  state: HealthState;
  at: string;
}
