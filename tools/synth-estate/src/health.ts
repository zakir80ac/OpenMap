// REQ-BSM-008 REQ-QA-001 (ADR-024) — deterministic health history for the synthetic estate's business services:
// outages (down) and degradations drawn per service and per month from the estate seed, so the availability report
// has months of data on a dev stack. The output is replayed by `pnpm --filter @openmap/reconciler replay-history`,
// which turns each outage into back-dated openmap.bsm.health.changed events through the outbox and into a resolved
// incident; nothing here touches a store.
import { SLA } from '@openmap/constants';
import type { BusinessServiceRecord } from './gen/applications.js';
import { Rng } from './rng.js';
import { MS_PER_DAY, MS_PER_MINUTE } from './time.js';

export const HEALTH_HISTORY_FILE = 'health-history.json';
const TIER_ONE = 1;
const DAYS_PER_MONTH = 30;

export type OutageState = 'down' | 'degraded';

export interface Outage {
  /** Business service name (its identity in the estate). */
  service: string;
  state: OutageState;
  startedAt: string;
  endedAt: string;
}

export interface HealthHistory {
  seed: number;
  generatedAt: string;
  months: number;
  outages: Outage[];
}

/**
 * Draws outages for every service over the `months` before `now`. A tier-1 service suffers fewer; roughly
 * SLA.synthetic.degradedShare of the incidents are degradations rather than outages. Outages never overlap within a
 * service and none is still open at `now`, so every one has a closing event.
 */
export function generateHealthHistory(
  services: readonly BusinessServiceRecord[],
  seed: number,
  now: string,
  months: number = SLA.synthetic.months,
): HealthHistory {
  const root = new Rng(seed).fork('health-history');
  const nowMs = Date.parse(now);
  const horizonMs = nowMs - months * DAYS_PER_MONTH * MS_PER_DAY;
  const outages: Outage[] = [];
  for (const service of [...services].sort((a, b) => a.name.localeCompare(b.name))) {
    const rng = root.fork(service.name);
    const factor = service.tier === TIER_ONE ? SLA.synthetic.tier1OutageFactor : 1;
    for (let month = 0; month < months; month++) {
      const count = Math.round(rng.int(0, SLA.synthetic.outagesPerServiceMonthMax) * factor);
      const monthStart = horizonMs + month * DAYS_PER_MONTH * MS_PER_DAY;
      // Each outage falls anywhere in its own equal slot of the window, so outages spread over the whole month
      // (and the days just before `now` see some) without two of one service overlapping.
      const slotMinutes = Math.floor((DAYS_PER_MONTH * MS_PER_DAY) / MS_PER_MINUTE / Math.max(1, count));
      for (let i = 0; i < count; i++) {
        const minutes = rng.int(SLA.synthetic.outageMinutesMin, SLA.synthetic.outageMinutesMax);
        const offsetMinutes = rng.int(0, Math.max(0, slotMinutes - minutes - 1));
        const start = monthStart + (i * slotMinutes + offsetMinutes) * MS_PER_MINUTE;
        const end = start + minutes * MS_PER_MINUTE;
        if (end >= nowMs) break;
        outages.push({
          service: service.name,
          state: rng.chance(SLA.synthetic.degradedShare) ? 'degraded' : 'down',
          startedAt: new Date(start).toISOString(),
          endedAt: new Date(end).toISOString(),
        });
      }
    }
  }
  outages.sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.service.localeCompare(b.service),
  );
  return { seed, generatedAt: now, months, outages };
}
