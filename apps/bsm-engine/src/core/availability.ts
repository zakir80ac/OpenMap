// REQ-BSM-006 REQ-BSM-008 (ADR-024) — availability arithmetic over a service's health-change history. Pure and
// deterministic: given the ordered changes, the state before a window and the window itself, it yields the minutes
// spent down, degraded and unknown, the availability percentage over the minutes the service was actually observed,
// and the error budget of an SLA target over that window. Calendar periods (month, quarter, year) are cut in the
// tenant's time zone, so "October" is October where the organisation operates, not in UTC.
import { BSM, SLA, TIME, type AvailabilityGranularity, type SlaWindow } from '@openmap/constants';
import type { Health } from './propagate.js';

export interface HealthChange {
  /** ISO instant the service entered `state`. */
  at: string;
  state: Health;
}

export interface TimeWindow {
  /** ISO instant, inclusive. */
  start: string;
  /** ISO instant, exclusive. */
  end: string;
}

/** A calendar period of the report, cut in the tenant's time zone. */
export interface CalendarPeriod extends TimeWindow {
  granularity: AvailabilityGranularity;
  year: number;
  /** 1–12 for a month period. */
  month: number | null;
  /** 1–4 for a quarter period. */
  quarter: number | null;
  /** True when the period has not ended yet (figures run to `now`). */
  current: boolean;
}

export interface AvailabilityFigures {
  /** Minutes of the window that have elapsed (the whole window once it has ended). */
  elapsedMinutes: number;
  downtimeMinutes: number;
  degradedMinutes: number;
  /** Minutes with no observation; excluded from the denominator rather than counted as up. */
  unknownMinutes: number;
  /** elapsedMinutes − unknownMinutes. */
  monitoredMinutes: number;
  /** (monitored − down) / monitored × 100; null when nothing was observed in the window. */
  availabilityPercent: number | null;
}

export interface WindowBudget {
  /** Downtime the target allows over the full window. */
  budgetMinutes: number;
  consumedMinutes: number;
  remainingMinutes: number;
  /** Budget consumed per elapsed fraction of the window; 1 exhausts exactly at window end. */
  burnRate: number;
  /** Whether the consumed downtime already exceeds the full-window budget. */
  breached: boolean;
  /** Whether the window's availability (so far) meets the target. */
  met: boolean;
}

const CALENDAR = {
  monthsPerYear: SLA.monthsPerYear,
  monthsPerQuarter: SLA.monthsPerQuarter,
  firstMonth: 1,
  firstDay: 1,
} as const;

function minutesBetween(fromMs: number, toMs: number): number {
  return Math.max(0, toMs - fromMs) / BSM.msPerMinute;
}

/**
 * Walks the changes through the window. Changes before the window only set the state at its start; the state at the
 * start is `initialState` when no change precedes the window. The window is clipped to `now`.
 */
export function availabilityIn(
  changes: readonly HealthChange[],
  initialState: Health,
  window: TimeWindow,
  now: string,
): AvailabilityFigures {
  const start = Date.parse(window.start);
  const end = Math.min(Date.parse(window.end), Date.parse(now));
  const totals = { down: 0, degraded: 0, unknown: 0 };
  if (end <= start)
    return {
      elapsedMinutes: 0,
      downtimeMinutes: 0,
      degradedMinutes: 0,
      unknownMinutes: 0,
      monitoredMinutes: 0,
      availabilityPercent: null,
    };
  let state: Health = initialState;
  let cursor = start;
  const sorted = [...changes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const change of sorted) {
    const at = Date.parse(change.at);
    if (at <= start) {
      state = change.state;
      continue;
    }
    if (at >= end) break;
    account(totals, state, cursor, at);
    cursor = at;
    state = change.state;
  }
  account(totals, state, cursor, end);
  const elapsedMinutes = minutesBetween(start, end);
  const monitoredMinutes = elapsedMinutes - totals.unknown;
  return {
    elapsedMinutes,
    downtimeMinutes: totals.down,
    degradedMinutes: totals.degraded,
    unknownMinutes: totals.unknown,
    monitoredMinutes,
    availabilityPercent:
      monitoredMinutes <= 0 ? null : ((monitoredMinutes - totals.down) / monitoredMinutes) * BSM.percentScale,
  };
}

function account(
  totals: { down: number; degraded: number; unknown: number },
  state: Health,
  fromMs: number,
  toMs: number,
): void {
  const minutes = minutesBetween(fromMs, toMs);
  if (state === 'down') totals.down += minutes;
  else if (state === 'degraded') totals.degraded += minutes;
  else if (state === 'unknown') totals.unknown += minutes;
}

/** Error budget of `targetPercent` over the whole window against the downtime consumed so far. */
export function windowBudget(
  targetPercent: number,
  window: TimeWindow,
  figures: AvailabilityFigures,
  now: string,
): WindowBudget {
  const fullMinutes = minutesBetween(Date.parse(window.start), Date.parse(window.end));
  const budgetMinutes = ((BSM.percentScale - targetPercent) / BSM.percentScale) * fullMinutes;
  const consumedMinutes = figures.downtimeMinutes;
  const remainingMinutes = budgetMinutes - consumedMinutes;
  const elapsedMinutes = Math.max(
    1,
    minutesBetween(Date.parse(window.start), Math.min(Date.parse(window.end), Date.parse(now))),
  );
  const expectedByNow = budgetMinutes * (elapsedMinutes / fullMinutes);
  const burnRate =
    expectedByNow <= 0
      ? consumedMinutes > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : consumedMinutes / expectedByNow;
  const met = figures.availabilityPercent === null ? true : figures.availabilityPercent >= targetPercent;
  return { budgetMinutes, consumedMinutes, remainingMinutes, burnRate, breached: remainingMinutes < 0, met };
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partFormatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partFormatters.set(timeZone, f);
  }
  return f;
}

/** Local calendar parts of an instant in `timeZone`. */
export function localParts(instantMs: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** The offset (ms) `timeZone` adds to UTC at `instantMs`. */
function offsetAt(instantMs: number, timeZone: string): number {
  const p = localParts(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - CALENDAR.firstMonth, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / TIME.msPerSecond) * TIME.msPerSecond;
}

/** UTC instant of local midnight on the given local date in `timeZone` (two passes absorb a DST change on that day). */
export function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - CALENDAR.firstMonth, day);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

function periodOf(
  granularity: AvailabilityGranularity,
  year: number,
  month: number,
  timeZone: string,
  nowMs: number,
): CalendarPeriod {
  let startMonth = month;
  let months = 1;
  let quarter: number | null = null;
  if (granularity === 'quarter') {
    quarter = Math.floor((month - CALENDAR.firstMonth) / CALENDAR.monthsPerQuarter) + 1;
    startMonth = (quarter - 1) * CALENDAR.monthsPerQuarter + CALENDAR.firstMonth;
    months = CALENDAR.monthsPerQuarter;
  } else if (granularity === 'year') {
    startMonth = CALENDAR.firstMonth;
    months = CALENDAR.monthsPerYear;
  }
  const startMs = zonedMidnightUtc(year, startMonth, CALENDAR.firstDay, timeZone);
  const endMonthIndex = startMonth - CALENDAR.firstMonth + months;
  const endMs = zonedMidnightUtc(
    year + Math.floor(endMonthIndex / CALENDAR.monthsPerYear),
    (endMonthIndex % CALENDAR.monthsPerYear) + CALENDAR.firstMonth,
    CALENDAR.firstDay,
    timeZone,
  );
  return {
    granularity,
    year,
    month: granularity === 'month' ? month : null,
    quarter,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    current: endMs > nowMs,
  };
}

/**
 * The last `count` calendar periods ending with the one containing `now`, oldest first. A quarter or a year steps back
 * by whole quarters or years; the current, unfinished period is included and flagged.
 */
export function calendarPeriods(
  granularity: AvailabilityGranularity,
  count: number,
  now: string,
  timeZone: string,
): CalendarPeriod[] {
  const nowMs = Date.parse(now);
  const local = localParts(nowMs, timeZone);
  const step =
    granularity === 'month'
      ? 1
      : granularity === 'quarter'
        ? CALENDAR.monthsPerQuarter
        : CALENDAR.monthsPerYear;
  const out: CalendarPeriod[] = [];
  for (let i = 0; i < count; i++) {
    // Month index counted from year 0 so stepping back crosses year boundaries without special cases.
    let monthIndex = local.year * CALENDAR.monthsPerYear + (local.month - CALENDAR.firstMonth);
    if (granularity === 'quarter')
      monthIndex -= (local.month - CALENDAR.firstMonth) % CALENDAR.monthsPerQuarter;
    if (granularity === 'year') monthIndex -= local.month - CALENDAR.firstMonth;
    monthIndex -= i * step;
    const year = Math.floor(monthIndex / CALENDAR.monthsPerYear);
    const month = (monthIndex % CALENDAR.monthsPerYear) + CALENDAR.firstMonth;
    out.push(periodOf(granularity, year, month, timeZone, nowMs));
  }
  return out.reverse();
}

/** The window an SLA target is measured over at `now`: the current calendar period in the tenant's zone, or the rolling days. */
export function slaWindowAt(window: SlaWindow, now: string, timeZone: string): TimeWindow {
  if (window === 'rolling_30d') {
    const end = Date.parse(now);
    return {
      start: new Date(end - SLA.rollingWindowDays * BSM.minutesPerDay * BSM.msPerMinute).toISOString(),
      end: now,
    };
  }
  const granularity: AvailabilityGranularity =
    window === 'calendar_month' ? 'month' : window === 'calendar_quarter' ? 'quarter' : 'year';
  const [period] = calendarPeriods(granularity, 1, now, timeZone);
  if (period === undefined) throw new Error('calendarPeriods returned no period');
  return { start: period.start, end: period.end };
}

/** Changes of one subject, oldest first, from a mixed history. */
export function changesOf(
  history: ReadonlyArray<HealthChange & { subject: string }>,
  subject: string,
): HealthChange[] {
  return history.filter((h) => h.subject === subject).map((h) => ({ at: h.at, state: h.state }));
}
