// T-134 REQ-BSM-008 — the synthetic health history is deterministic, closed and ordered.
import { describe, expect, it } from 'vitest';
import type { BusinessServiceRecord } from './gen/applications.js';
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

  it('gives a tier-1 service fewer incidents than a standard one', () => {
    const history = generateHealthHistory([service('Core', 1), service('Standard', 3)], 11, now, 14);
    const core = history.outages.filter((o) => o.service === 'Core').length;
    const standard = history.outages.filter((o) => o.service === 'Standard').length;
    expect(core).toBeLessThan(standard);
  });
});
