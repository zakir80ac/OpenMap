// T-132 REQ-BSM-006 REQ-BSM-008 — availability arithmetic: windows, unknown time, calendar periods in a time zone,
// SLA windows and error budgets.
import { describe, expect, it } from 'vitest';
import {
  availabilityIn,
  calendarPeriods,
  changesOf,
  slaWindowAt,
  windowBudget,
  zonedMidnightUtc,
} from './availability.js';

const RIYADH = 'Asia/Riyadh';
const UTC = 'UTC';
const DAY_MINUTES = 1440;

describe('availabilityIn', () => {
  const window = { start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' };
  const after = '2026-11-01T00:00:00.000Z';

  it('counts an outage inside the window and nothing else', () => {
    const f = availabilityIn(
      [
        { at: '2026-10-01T10:00:00.000Z', state: 'down' },
        { at: '2026-10-01T10:30:00.000Z', state: 'healthy' },
      ],
      'healthy',
      window,
      after,
    );
    expect(f.elapsedMinutes).toBe(DAY_MINUTES);
    expect(f.downtimeMinutes).toBe(30);
    expect(f.degradedMinutes).toBe(0);
    expect(f.unknownMinutes).toBe(0);
    expect(f.availabilityPercent).toBeCloseTo(((DAY_MINUTES - 30) / DAY_MINUTES) * 100, 6);
  });

  it('starts from the state the service had before the window and clips the window to now', () => {
    const now = '2026-10-01T06:00:00.000Z';
    const f = availabilityIn(
      [
        { at: '2026-09-30T23:00:00.000Z', state: 'down' },
        { at: '2026-10-01T01:00:00.000Z', state: 'healthy' },
      ],
      'healthy',
      window,
      now,
    );
    expect(f.elapsedMinutes).toBe(360);
    expect(f.downtimeMinutes).toBe(60);
    expect(f.availabilityPercent).toBeCloseTo((300 / 360) * 100, 6);
  });

  it('excludes unknown minutes from the denominator and counts degraded as available', () => {
    const f = availabilityIn(
      [
        { at: '2026-10-01T00:00:00.000Z', state: 'unknown' },
        { at: '2026-10-01T12:00:00.000Z', state: 'degraded' },
        { at: '2026-10-01T18:00:00.000Z', state: 'down' },
        { at: '2026-10-01T19:00:00.000Z', state: 'healthy' },
      ],
      'healthy',
      window,
      after,
    );
    expect(f.unknownMinutes).toBe(720);
    expect(f.degradedMinutes).toBe(360);
    expect(f.downtimeMinutes).toBe(60);
    expect(f.monitoredMinutes).toBe(720);
    expect(f.availabilityPercent).toBeCloseTo((660 / 720) * 100, 6);
  });

  it('reports null availability when the window was never observed or has not started', () => {
    expect(availabilityIn([], 'unknown', window, after).availabilityPercent).toBeNull();
    expect(availabilityIn([], 'healthy', window, '2026-09-01T00:00:00.000Z').availabilityPercent).toBeNull();
    expect(availabilityIn([], 'healthy', window, after).availabilityPercent).toBe(100);
  });

  it('accepts changes out of order', () => {
    const a = availabilityIn(
      [
        { at: '2026-10-01T10:30:00.000Z', state: 'healthy' },
        { at: '2026-10-01T10:00:00.000Z', state: 'down' },
      ],
      'healthy',
      window,
      after,
    );
    expect(a.downtimeMinutes).toBe(30);
  });
});

describe('windowBudget', () => {
  const window = { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' };
  it('derives the budget from the target over the full window and the burn rate from the elapsed share', () => {
    // 99.9% of 31 days allows 44.64 minutes; 20 minutes down half-way through burns at 0.896.
    const now = '2026-10-16T12:00:00.000Z';
    const f = availabilityIn(
      [
        { at: '2026-10-05T00:00:00.000Z', state: 'down' },
        { at: '2026-10-05T00:20:00.000Z', state: 'healthy' },
      ],
      'healthy',
      window,
      now,
    );
    const b = windowBudget(99.9, window, f, now);
    expect(b.budgetMinutes).toBeCloseTo(44.64, 2);
    expect(b.consumedMinutes).toBe(20);
    expect(b.remainingMinutes).toBeCloseTo(24.64, 2);
    expect(b.burnRate).toBeCloseTo(20 / (44.64 * 0.5), 2);
    expect(b.breached).toBe(false);
    expect(b.met).toBe(true);
  });
  it('flags a breach once consumed downtime exceeds the budget', () => {
    const now = '2026-10-02T00:00:00.000Z';
    const f = availabilityIn(
      [
        { at: '2026-10-01T00:00:00.000Z', state: 'down' },
        { at: '2026-10-01T01:00:00.000Z', state: 'healthy' },
      ],
      'healthy',
      window,
      now,
    );
    const b = windowBudget(99.9, window, f, now);
    expect(b.breached).toBe(true);
    expect(b.met).toBe(false);
    expect(b.remainingMinutes).toBeLessThan(0);
  });
});

describe('calendar periods', () => {
  const now = '2026-11-05T07:30:00.000Z';

  it('cuts months at local midnight in the tenant zone', () => {
    expect(zonedMidnightUtc(2026, 11, 1, RIYADH)).toBe(Date.parse('2026-10-31T21:00:00.000Z'));
    expect(zonedMidnightUtc(2026, 11, 1, UTC)).toBe(Date.parse('2026-11-01T00:00:00.000Z'));
    const [september, october, november] = calendarPeriods('month', 3, now, RIYADH);
    expect(september).toMatchObject({
      year: 2026,
      month: 9,
      quarter: null,
      start: '2026-08-31T21:00:00.000Z',
      end: '2026-09-30T21:00:00.000Z',
      current: false,
    });
    expect(october).toMatchObject({
      year: 2026,
      month: 10,
      start: '2026-09-30T21:00:00.000Z',
      end: '2026-10-31T21:00:00.000Z',
      current: false,
    });
    expect(november).toMatchObject({
      year: 2026,
      month: 11,
      start: '2026-10-31T21:00:00.000Z',
      current: true,
    });
  });

  it('steps quarters and years back across year boundaries', () => {
    const quarters = calendarPeriods('quarter', 5, now, UTC);
    expect(quarters.map((q) => [q.year, q.quarter])).toEqual([
      [2025, 4],
      [2026, 1],
      [2026, 2],
      [2026, 3],
      [2026, 4],
    ]);
    expect(quarters[0]).toMatchObject({
      start: '2025-10-01T00:00:00.000Z',
      end: '2026-01-01T00:00:00.000Z',
      month: null,
    });
    const years = calendarPeriods('year', 3, now, UTC);
    expect(years.map((y) => y.year)).toEqual([2024, 2025, 2026]);
    expect(years[2]).toMatchObject({
      start: '2026-01-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
      current: true,
    });
  });

  it('honours a daylight-saving zone on both sides of the change', () => {
    expect(new Date(zonedMidnightUtc(2026, 7, 1, 'Europe/London')).toISOString()).toBe(
      '2026-06-30T23:00:00.000Z',
    );
    expect(new Date(zonedMidnightUtc(2026, 12, 1, 'Europe/London')).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    );
  });

  it('resolves an SLA window to the current period or the rolling days', () => {
    expect(slaWindowAt('calendar_month', now, RIYADH)).toEqual({
      start: '2026-10-31T21:00:00.000Z',
      end: '2026-11-30T21:00:00.000Z',
    });
    expect(slaWindowAt('calendar_quarter', now, UTC)).toEqual({
      start: '2026-10-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    });
    expect(slaWindowAt('calendar_year', now, UTC)).toEqual({
      start: '2026-01-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    });
    expect(slaWindowAt('rolling_30d', now, UTC)).toEqual({ start: '2026-10-06T07:30:00.000Z', end: now });
  });

  it('filters a mixed history by subject', () => {
    const history = [
      { subject: 'a', at: '2026-10-01T00:00:00.000Z', state: 'down' as const },
      { subject: 'b', at: '2026-10-01T00:00:00.000Z', state: 'healthy' as const },
    ];
    expect(changesOf(history, 'a')).toEqual([{ at: '2026-10-01T00:00:00.000Z', state: 'down' }]);
  });
});
