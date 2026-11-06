// T-187 REQ-CMDB-032 (ADR-036) — the watcher's planning: a certificate far from expiry raises nothing, one first seen
// inside a threshold raises that threshold only, an alert already raised is not raised again, an expired one raises
// threshold 0, and an unreadable notAfter is skipped; endpoints are carried into the alert.
import { describe, expect, it } from 'vitest';
import { alertKey, dueAlerts, type CertificateCandidate } from './certificates.js';

const now = new Date('2026-11-06T00:00:00Z');
const cert = (ciId: string, notAfter: string): CertificateCandidate => ({ tenantId: 't1', ciId, subject: 'CN=' + ciId, notAfter });

describe('certificate expiry planning', () => {
  it('raises the threshold reached, once', () => {
    const candidates = [
      cert('far', '2027-06-01T00:00:00Z'),
      cert('soon', '2026-11-11T00:00:00Z'),
      cert('gone', '2026-11-01T00:00:00Z'),
      cert('bad', 'not a date'),
      cert('done', '2026-11-30T00:00:00Z'),
    ];
    const raised = new Set([alertKey('done', '2026-11-30T00:00:00Z', 30)]);
    const alerts = dueAlerts(candidates, raised, new Map([['soon', 3]]), now);
    expect(alerts.map((a) => [a.ciId, a.thresholdDays, a.daysLeft, a.expired, a.endpoints])).toEqual([
      ['soon', 7, 5, false, 3],
      ['gone', 0, -5, true, 0],
    ]);
    expect(alerts[0]?.notAfter).toBe('2026-11-11T00:00:00.000Z');
  });
});
