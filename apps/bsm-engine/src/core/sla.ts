// REQ-BSM-002 — SLA error budgets. Budget for the period is (1 - target) × period; burn rate is the
// fraction of budget consumed per elapsed fraction of the period.
import { BSM } from '@openmap/constants';

export interface SlaInput {
  /** Target availability as a percentage, e.g. 99.95. */
  targetPercent: number;
  /** Start of the current period (ISO). */
  periodStart: string;
  /** Minutes of downtime recorded so far in the period. */
  downtimeMinutes: number;
  now: string;
}

export interface SlaStatus {
  budgetMinutes: number;
  consumedMinutes: number;
  remainingMinutes: number;
  consumedPercent: number;
  /** 1.0 means burning exactly at the rate that exhausts the budget at period end. */
  burnRate: number;
  /** ISO time the budget is exhausted at the current burn rate; null when not burning. */
  breachForecast: string | null;
  breached: boolean;
}

export function slaStatus(input: SlaInput): SlaStatus {
  const periodMinutes = BSM.slaPeriodDays * BSM.minutesPerDay;
  const budgetMinutes = ((BSM.percentScale - input.targetPercent) / BSM.percentScale) * periodMinutes;
  const consumedMinutes = Math.min(input.downtimeMinutes, Number.MAX_SAFE_INTEGER);
  const remainingMinutes = Math.max(0, budgetMinutes - consumedMinutes);
  const consumedPercent = budgetMinutes === 0 ? BSM.percentScale : Math.min(BSM.percentScale, (consumedMinutes / budgetMinutes) * BSM.percentScale);
  const elapsedMinutes = Math.max(1, (Date.parse(input.now) - Date.parse(input.periodStart)) / BSM.msPerMinute);
  const expectedConsumedByNow = budgetMinutes * (elapsedMinutes / periodMinutes);
  const burnRate = expectedConsumedByNow === 0 ? 0 : consumedMinutes / expectedConsumedByNow;
  const minutesPerMinute = consumedMinutes / elapsedMinutes;
  const breachForecast = remainingMinutes > 0 && minutesPerMinute > 0 ? new Date(Date.parse(input.now) + (remainingMinutes / minutesPerMinute) * BSM.msPerMinute).toISOString() : null;
  return { budgetMinutes, consumedMinutes, remainingMinutes, consumedPercent, burnRate, breachForecast, breached: remainingMinutes === 0 };
}

/** Minutes of budget left if an outage of `outageMinutes` happens now. Negative means breach. */
export function remainingAfterOutage(status: SlaStatus, outageMinutes: number): number {
  return status.remainingMinutes - outageMinutes;
}
