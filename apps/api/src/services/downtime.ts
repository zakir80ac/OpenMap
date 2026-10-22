// REQ-BSM-002 — downtime arithmetic over a service's health-change history: minutes spent `down`
// inside the SLA period, given the state at period start. Pure.
import { BSM } from '@openmap/constants';
import type { HealthState } from '../ci/ci.types.js';
import type { HealthEvent } from './services.types.js';

export function downtimeMinutes(events: readonly HealthEvent[], initialState: HealthState, periodStart: string, now: string): number {
  let state: HealthState = initialState;
  let cursor = Date.parse(periodStart);
  const end = Date.parse(now);
  let downMs = 0;
  for (const e of events) {
    const at = Math.min(Math.max(Date.parse(e.at), cursor), end);
    if (state === 'down') downMs += at - cursor;
    cursor = at;
    state = e.state;
  }
  if (state === 'down' && end > cursor) downMs += end - cursor;
  return downMs / BSM.msPerMinute;
}

/** Start of the rolling SLA period ending at `now`. */
export function periodStartFor(now: string): string {
  return new Date(Date.parse(now) - BSM.slaPeriodDays * BSM.minutesPerDay * BSM.msPerMinute).toISOString();
}
