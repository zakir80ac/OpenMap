// T-601 REQ-SEC-012 (ADR-070) — assess(): every fact family becomes check outcomes, an OS failure counts against the
// host it is installed on, the deployment's own backup is one subject, and the stored high-risk flag marks only
// failures on CIs that carry a high or critical CVE.
import { describe, expect, it } from 'vitest';
import { LIFECYCLE, TIME } from '@openmap/constants';
import { assess, isHighRiskOutcome, type ComplianceFacts } from './compliance.service.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * TIME.msPerDay).toISOString();

function facts(): ComplianceFacts {
  return {
    exposure: [
      { ciId: 'host-1', installed: 3, cves: [{ cveId: 'CVE-2024-0001', severity: 'critical', cvss: 9.8, exploited: true }] },
      { ciId: 'host-2', installed: 2, cves: [{ cveId: 'CVE-2024-0002', severity: 'low', cvss: 3.1, exploited: false }] },
    ],
    operatingSystems: [
      { ciId: 'os-1', lastPatchedAt: daysAgo(LIFECYCLE.patchStaleDays * 2), hostId: 'host-1' },
      { ciId: 'os-2', lastPatchedAt: daysAgo(1), hostId: 'host-2' },
    ],
    releases: [
      { ciId: 'os-1', state: 'ended', label: 'Ubuntu 18.04', endOfSupport: '2023-05-31' },
      { ciId: 'os-2', state: 'supported', label: 'Ubuntu 24.04', endOfSupport: '2029-05-31' },
    ],
    hardware: [{ ciId: 'host-2', endOfSupport: '2025-01-01', source: 'vendor' }],
    certificates: [{ ciId: 'cert-1', subject: 'CN=portal', notAfter: daysAgo(3), daysLeft: -3, expired: true, weaknesses: [] }],
    tls: [{ ciId: 'tls-1', tlsVersion: 'TLS 1.0', endpoint: 'portal:443' }],
    storage: [{ ciId: 'bucket-1', attributes: { encryption: 'none' } }],
    shares: [{ ciId: 'share-1', protocol: 'smb', options: ['encrypt'] }],
    buckets: [{ ciId: 'bucket-1', publicAccessBlocked: false }],
    databases: [{ ciId: 'db-1', lastBackupAt: null }],
    firewalls: [{ ciId: 'fw-1', rules: 4, permissive: 0, truncated: false }],
    platformBackup: { configured: false, stale: true, lastCompleteAt: null, newestEncrypted: null, staleAfterHours: 26 },
  };
}

describe('assess', () => {
  it('evaluates every family and computes the posture from the outcomes', () => {
    const a = assess(facts(), NOW);
    const decided = (check: string, ci: string | null) => a.outcomes.find((o) => o.check === check && o.ciId === ci)?.result;
    expect(decided('cve_high_critical', 'host-1')).toBe('fail');
    expect(decided('cve_high_critical', 'host-2')).toBe('pass');
    expect(decided('release_supported', 'os-1')).toBe('fail');
    expect(decided('os_patched', 'os-1')).toBe('fail');
    expect(decided('os_patched', 'os-2')).toBe('pass');
    expect(decided('hardware_supported', 'host-2')).toBe('fail');
    expect(decided('certificate_valid', 'cert-1')).toBe('fail');
    expect(decided('tls_modern', 'tls-1')).toBe('fail');
    expect(decided('storage_encrypted', 'bucket-1')).toBe('fail');
    expect(decided('share_encrypted', 'share-1')).toBe('pass');
    expect(decided('bucket_public_blocked', 'bucket-1')).toBe('fail');
    expect(decided('database_backup_recent', 'db-1')).toBe('not_applicable');
    expect(decided('firewall_no_permissive', 'fw-1')).toBe('pass');
    expect(decided('platform_backup_recent', null)).toBe('fail');
    expect([...a.exposed]).toEqual(['host-1']);
    expect(a.anchors.get('os-1')).toBe('host-1');
    expect(a.cveRisk).toEqual({ critical: 1, high: 0, exploited: 1, exposedCis: 1 });

    // host-1 fails the CVE checks and, through os-1, the release and patch checks; host-2 fails hardware but has no
    // high CVE, so each framework that evaluates any of those has exactly one high-risk CI.
    for (const f of a.frameworks) expect(f.highRiskCis).toBe(1);
    const iso = a.frameworks.find((f) => f.framework === 'iso27001');
    const evaluated = (iso?.evaluations.passed ?? 0) + (iso?.evaluations.failed ?? 0);
    expect(iso?.passRate).toBeCloseTo((iso?.evaluations.passed ?? 0) / evaluated);
    expect(iso?.controls.find((c) => c.controlId === 'A.8.20')?.result).toBe('pass');
    expect(iso?.controls.find((c) => c.controlId === 'A.8.13')?.result).toBe('fail');
  });

  it('flags as high risk only the failures anchored on an exposed CI', () => {
    const a = assess(facts(), NOW);
    const flagged = a.outcomes.filter((o) => isHighRiskOutcome(o, a.exposed, a.anchors)).map((o) => o.check + ':' + String(o.ciId)).sort();
    expect(flagged).toEqual(['cve_exploited:host-1', 'cve_high_critical:host-1', 'os_patched:os-1', 'release_supported:os-1']);
  });
});
