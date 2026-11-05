// REQ-BSM-002 REQ-BSM-006 REQ-BSM-008 — view types for ServiceHealth, Sla, AvailabilityPeriod, Incident (with response
// targets and RCA), IncidentEvent and IncidentLink (ADR-024).
import type { AvailabilityGranularity, SlaWindow } from '@openmap/constants';
import type { IncidentSeverity, SeverityTargets } from '@openmap/bsm-engine';
import type { CiRecord, HealthState } from '../ci/ci.types.js';

export interface SeverityTargetView {
  severity: IncidentSeverity;
  respondMinutes: number;
  resolveMinutes: number;
}

export interface SlaRecord {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  availabilityTargetPercent: number;
  window: SlaWindow;
  /** The SLA's own targets; the resolver fills the missing severities from the defaults. */
  ownTargets: Partial<SeverityTargets>;
  burnRateAlert: number;
  /** Business services held to this SLA. */
  serviceCiIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilityPeriodView {
  granularity: AvailabilityGranularity | null;
  year: number;
  month: number | null;
  quarter: number | null;
  periodStart: string;
  periodEnd: string;
  current: boolean;
  availabilityPercent: number | null;
  elapsedMinutes: number;
  downtimeMinutes: number;
  degradedMinutes: number;
  unknownMinutes: number;
  targetPercent: number | null;
  met: boolean | null;
  budgetMinutes: number | null;
  budgetRemainingMinutes: number | null;
  burnRate: number | null;
  /** The service the period belongs to; the `incidents` field resolver reads it. */
  serviceCiId: string;
}

export interface ServiceAvailabilityView {
  service: CiRecord;
  sla: SlaRecord | null;
  periods: AvailabilityPeriodView[];
}

export interface ServiceHealthView {
  service: CiRecord;
  state: HealthState;
  since: string;
  rootCauses: CiRecord[];
  slaTarget: number;
  errorBudgetRemainingMinutes: number;
  sla: SlaRecord | null;
  currentWindow: AvailabilityPeriodView;
}

export interface CorrectiveActionView {
  description: string;
  owner: string | null;
  dueAt: string | null;
  done: boolean;
}

export interface RcaView {
  summary: string;
  rootCauseCiId: string | null;
  contributingFactors: string[];
  correctiveActions: CorrectiveActionView[];
  owner: string | null;
  dueAt: string | null;
  completedAt: string | null;
  updatedBy: string;
  updatedAt: string;
}

export type IncidentState = 'open' | 'acknowledged' | 'mitigated' | 'resolved' | 'closed';

export interface IncidentRecord {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  state: IncidentState;
  source: string;
  serviceCiId: string | null;
  affectedServiceCiIds: string[];
  rootCauseCiId: string | null;
  slaId: string | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  assignee: string | null;
  respondBy: string | null;
  resolveBy: string | null;
  responseBreachedAt: string | null;
  resolutionBreachedAt: string | null;
  resolutionNote: string | null;
  rca: RcaView | null;
  /** Alerts correlated into the incident. */
  alerts: number;
}

export interface IncidentEventView {
  at: string;
  actor: string;
  kind: string;
  details: Record<string, unknown>;
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
