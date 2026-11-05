// REQ-BSM-006 (ADR-024) — SLA decisions. Pure: given each service's SLA, the availability figures of the current
// window and the SLA incident already open for it, say which breach incidents to open, which at-risk alerts to raise
// and which breach incidents to close because the window rolled over; and, for open incidents, which response or
// resolution targets have just been missed. Persistence, events and delivery happen in engine.ts.
import { BSM, ITSM, SLA, type SlaWindow } from '@openmap/constants';
import type { AvailabilityFigures, TimeWindow, WindowBudget } from '../core/availability.js';
import type { IncidentSeverity } from './incidents.js';

export interface SeverityTarget {
  respondMinutes: number;
  resolveMinutes: number;
}

export type SeverityTargets = Record<IncidentSeverity, SeverityTarget>;

export interface SlaDefinition {
  id: string;
  name: string;
  availabilityTargetPercent: number;
  window: SlaWindow;
  /** Response and resolution targets by severity; a severity with no entry falls back to SLA.defaultTargets. */
  responseTargets: Partial<SeverityTargets>;
  burnRateAlert: number;
}

export interface OpenSlaIncident {
  id: string;
  openedAt: string;
}

export interface SlaServiceInput {
  serviceCiId: string;
  name: string;
  tier: number;
  sla: SlaDefinition;
  window: TimeWindow;
  figures: AvailabilityFigures;
  budget: WindowBudget;
  /** The breach incident (source 'sla') still open for the service, if any. */
  openIncident: OpenSlaIncident | null;
  /** Whether an at-risk alert was already raised for this service inside the current window. */
  atRiskRaised: boolean;
}

export interface BreachAction {
  kind: 'breach';
  serviceCiId: string;
  slaId: string;
  severity: IncidentSeverity;
  title: string;
  description: string;
  budget: WindowBudget;
}

export interface AtRiskAction {
  kind: 'at_risk';
  serviceCiId: string;
  slaId: string;
  burnRate: number;
  remainingMinutes: number;
  /** ISO instant the budget runs out at the current burn rate. */
  forecastAt: string;
}

/** The window the breach was raised in has ended and the new window is within budget: the breach incident closes. */
export interface ClearAction {
  kind: 'clear';
  incidentId: string;
  serviceCiId: string;
}

export type SlaAction = BreachAction | AtRiskAction | ClearAction;

/** A missed SLA target is critical for tier-1 services and high for every other. */
export function breachSeverity(tier: number): IncidentSeverity {
  return tier === ITSM.priorityHighest ? 'critical' : 'high';
}

function minutesText(minutes: number): string {
  return String(Math.round(minutes));
}

export function slaActions(inputs: readonly SlaServiceInput[], now: string): SlaAction[] {
  const out: SlaAction[] = [];
  for (const s of inputs) {
    const { budget, sla } = s;
    if (budget.breached) {
      if (s.openIncident === null) {
        out.push({
          kind: 'breach',
          serviceCiId: s.serviceCiId,
          slaId: sla.id,
          severity: breachSeverity(s.tier),
          title: s.name + ' SLA breached',
          description:
            s.name +
            ' consumed ' +
            minutesText(budget.consumedMinutes) +
            ' of ' +
            minutesText(budget.budgetMinutes) +
            ' minutes of downtime allowed by ' +
            sla.name +
            ' (' +
            String(sla.availabilityTargetPercent) +
            '%) for the window starting ' +
            s.window.start +
            '.',
          budget,
        });
      }
      continue;
    }
    if (s.openIncident !== null && Date.parse(s.openIncident.openedAt) < Date.parse(s.window.start)) {
      out.push({ kind: 'clear', incidentId: s.openIncident.id, serviceCiId: s.serviceCiId });
    }
    if (
      !s.atRiskRaised &&
      budget.consumedMinutes > 0 &&
      budget.burnRate >= sla.burnRateAlert &&
      budget.remainingMinutes > 0
    ) {
      const elapsedMinutes = Math.max(1, s.figures.elapsedMinutes);
      const minutesPerMinute = budget.consumedMinutes / elapsedMinutes;
      const forecastAt = new Date(
        Date.parse(now) + (budget.remainingMinutes / minutesPerMinute) * BSM.msPerMinute,
      ).toISOString();
      out.push({
        kind: 'at_risk',
        serviceCiId: s.serviceCiId,
        slaId: sla.id,
        burnRate: budget.burnRate,
        remainingMinutes: budget.remainingMinutes,
        forecastAt,
      });
    }
  }
  return out;
}

/** The response and resolution targets that apply to a severity under an SLA (or the defaults without one). */
export function targetFor(
  sla: Pick<SlaDefinition, 'responseTargets'> | null,
  severity: IncidentSeverity,
): SeverityTarget {
  return sla?.responseTargets[severity] ?? SLA.defaultTargets[severity];
}

export interface IncidentTargets {
  respondBy: string;
  resolveBy: string;
}

/** Absolute deadlines of an incident opened at `openedAt` with `severity`. */
export function targetsFor(
  sla: Pick<SlaDefinition, 'responseTargets'> | null,
  severity: IncidentSeverity,
  openedAt: string,
): IncidentTargets {
  const t = targetFor(sla, severity);
  const opened = Date.parse(openedAt);
  return {
    respondBy: new Date(opened + t.respondMinutes * BSM.msPerMinute).toISOString(),
    resolveBy: new Date(opened + t.resolveMinutes * BSM.msPerMinute).toISOString(),
  };
}

export interface TrackedIncident {
  id: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  respondBy: string | null;
  resolveBy: string | null;
  responseBreachedAt: string | null;
  resolutionBreachedAt: string | null;
}

export interface TargetBreach {
  incidentId: string;
  kind: 'response' | 'resolution';
}

/** Targets missed as of `now` that have not been recorded yet. A resolved incident can no longer miss anything. */
export function targetBreaches(incidents: readonly TrackedIncident[], now: string): TargetBreach[] {
  const nowMs = Date.parse(now);
  const out: TargetBreach[] = [];
  for (const i of incidents) {
    if (i.resolvedAt !== null) continue;
    if (
      i.respondBy !== null &&
      i.acknowledgedAt === null &&
      i.responseBreachedAt === null &&
      nowMs >= Date.parse(i.respondBy)
    )
      out.push({ incidentId: i.id, kind: 'response' });
    if (i.resolveBy !== null && i.resolutionBreachedAt === null && nowMs >= Date.parse(i.resolveBy))
      out.push({ incidentId: i.id, kind: 'resolution' });
  }
  return out;
}
