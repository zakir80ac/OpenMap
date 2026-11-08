// T-134 T-464 REQ-BSM-008 — the synthetic health history is deterministic, closed and ordered, and its outages
// spread over the whole of each month rather than its first half.
import { describe, expect, it } from 'vitest';
import type { BusinessServiceRecord } from './gen/applications.js';
import { ANOMALY } from '@openmap/constants';
import { generateHealthHistory } from './health.js';

const service = (name: string, tier: number): BusinessServiceRecord => ({
  name,
  tier,
  businessUnit: 'Retail',
  users: 100,
  revenuePerHour: 10,
  currency: 'SAR',
  criticality: 'high',
  rtoMinutes: 60,
  rpoMinutes: 60,
  slaTargetPercent: 99.9,
  applications: [],
  identity: { name },
});
const now = '2026-11-05T07:30:00.000Z';

describe('generateHealthHistory', () => {
  it('is byte-identical for the same seed and differs for another', () => {
    const a = generateHealthHistory([service('Online banking', 1), service('HR portal', 3)], 42, now, 6);
    const b = generateHealthHistory([service('HR portal', 3), service('Online banking', 1)], 42, now, 6);
    const c = generateHealthHistory([service('Online banking', 1), service('HR portal', 3)], 43, now, 6);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    expect(a.outages.length).toBeGreaterThan(0);
  });

  it('closes every outage before now, keeps a service free of overlaps, and sorts by start', () => {
    const history = generateHealthHistory([service('Payments', 2), service('CRM', 3)], 7, now, 14);
    const byService = new Map<string, number>();
    for (const [i, o] of history.outages.entries()) {
      expect(Date.parse(o.endedAt)).toBeGreaterThan(Date.parse(o.startedAt));
      expect(Date.parse(o.endedAt)).toBeLessThan(Date.parse(now));
      expect(['down', 'degraded']).toContain(o.state);
      const previous = byService.get(o.service);
      if (previous !== undefined) expect(Date.parse(o.startedAt)).toBeGreaterThanOrEqual(previous);
      byService.set(o.service, Date.parse(o.endedAt));
      const next = history.outages[i + 1];
      if (next) expect(Date.parse(next.startedAt)).toBeGreaterThanOrEqual(Date.parse(o.startedAt));
    }
  });

  it('T-464 spreads outages over the whole month, the days just before now included', () => {
    const services = Array.from({ length: 60 }, (_, i) => service('Service ' + String(i), 3));
    const history = generateHealthHistory(services, 42, now, 14);
    const dayMs = 86_400_000;
    const recent = history.outages.filter((o) => Date.parse(now) - Date.parse(o.startedAt) < 10 * dayMs);
    expect(recent.length).toBeGreaterThan(0);
    // Within each 30-day window, about half of the outages start in its second half.
    const horizon = Date.parse(now) - 14 * 30 * dayMs;
    const late = history.outages.filter((o) => ((Date.parse(o.startedAt) - horizon) % (30 * dayMs)) >= 15 * dayMs).length;
    expect(late / history.outages.length).toBeGreaterThan(0.3);
  });

  it('gives a tier-1 service fewer incidents than a standard one', () => {
    const history = generateHealthHistory([service('Core', 1), service('Standard', 3)], 11, now, 14);
    const core = history.outages.filter((o) => o.service === 'Core').length;
    const standard = history.outages.filter((o) => o.service === 'Standard').length;
    expect(core).toBeLessThan(standard);
  });
});

// T-502 REQ-AI-003 — the planted flapping service: ANOMALY.synthetic.flapOutages short outages within the flapping
// rule's window before `now`, no overlap with the service's other outages, and recorded as ground truth.
describe('planted flapping service', () => {
  it('bursts one service inside the flapping window and records it', () => {
    const now = '2026-11-01T00:00:00.000Z';
    const h = generateHealthHistory([service('Online banking', 1), service('HR portal', 3), service('Cards', 2)], 42, now, 6);
    expect(h.anomalies).toHaveLength(1);
    const name = h.anomalies[0]?.subject ?? '';
    const own = h.outages.filter((o) => o.service === name).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const windowMs = ANOMALY.flapWindowHours * 3_600_000;
    const burst = own.filter((o) => Date.parse(now) - Date.parse(o.endedAt) < windowMs);
    expect(burst.length * 2).toBeGreaterThanOrEqual(ANOMALY.flapChanges);
    for (let i = 1; i < own.length; i++) expect(Date.parse(own[i]?.startedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(own[i - 1]?.endedAt ?? ''));
  });
});
