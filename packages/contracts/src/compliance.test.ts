// T-600 REQ-SEC-012 (ADR-070) — the compliance checks decide pass, fail or not applicable from the facts alone, the
// catalogue is consistent, and the per-framework posture (pass rate, control results, high-risk CIs) follows the
// outcomes.
import { describe, expect, it } from 'vitest';
import { COMPLIANCE, LIFECYCLE, TIME } from '@openmap/constants';
import {
  COMPLIANCE_CATALOGUE,
  COMPLIANCE_CHECKS,
  COMPLIANCE_FRAMEWORKS,
  checkBucketPublic,
  checkCertificate,
  checkCveExposure,
  checkDatabaseBackup,
  checkFirewall,
  checkHardware,
  checkPatch,
  checkPlatformBackup,
  checkRelease,
  checkShareEncryption,
  checkStorageEncryption,
  checkTls,
  compliancePosture,
  cveRisk,
  frameworkChecks,
  isHighRiskCve,
  passRate,
  tlsRank,
  type ComplianceOutcome,
  type CveFact,
} from './compliance.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * TIME.msPerDay).toISOString();
const hoursAgo = (n: number): string => new Date(NOW.getTime() - n * TIME.msPerHour).toISOString();
const cve = (cveId: string, severity: string, cvss: number, exploited = false): CveFact => ({ cveId, severity, cvss, exploited });

describe('catalogue', () => {
  it('covers every framework once, with distinct control ids, and every check is used somewhere', () => {
    expect(COMPLIANCE_CATALOGUE.map((f) => f.id)).toEqual([...COMPLIANCE_FRAMEWORKS]);
    for (const f of COMPLIANCE_CATALOGUE) {
      const ids = f.controls.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const c of f.controls) expect(c.checks.length).toBeGreaterThan(0);
    }
    const used = new Set(COMPLIANCE_CATALOGUE.flatMap(frameworkChecks));
    expect([...used].sort()).toEqual([...COMPLIANCE_CHECKS].sort());
  });
});

describe('checks', () => {
  it('CVE exposure: high or critical fails, exploited fails, an unlabelled CVE counts by CVSS', () => {
    const [high, exploited] = checkCveExposure('h1', 4, [cve('CVE-1', 'medium', 5.0), cve('CVE-2', 'critical', 9.8), cve('CVE-3', 'high', 7.5, true)]);
    expect(high).toMatchObject({ check: 'cve_high_critical', result: 'fail', reason: 'high_cve', facts: { highOrCritical: 2, critical: 1, worstCve: 'CVE-2', worstCvss: 9.8 } });
    expect(exploited).toMatchObject({ check: 'cve_exploited', result: 'fail', facts: { exploited: 1, worstCve: 'CVE-3' } });
    const clean = checkCveExposure('h2', 3, [cve('CVE-4', 'low', 2.1)]);
    expect(clean.map((o) => o.result)).toEqual(['pass', 'pass']);
    expect(isHighRiskCve({ severity: 'unknown', cvss: COMPLIANCE.highRiskCvss })).toBe(true);
    expect(isHighRiskCve({ severity: 'medium', cvss: COMPLIANCE.highRiskCvss + 1 })).toBe(false);
  });

  it('releases: ended fails, ending and supported pass, unknown is not applicable', () => {
    const r = (state: 'ended' | 'ending' | 'supported' | 'unknown') => checkRelease('o1', { state, label: 'Ubuntu 18.04', endOfSupport: '2023-05-31' }).result;
    expect([r('ended'), r('ending'), r('supported'), r('unknown')]).toEqual(['fail', 'pass', 'pass', 'not_applicable']);
  });

  it('patches: older than LIFECYCLE.patchStaleDays fails, missing is not applicable', () => {
    expect(checkPatch('o1', daysAgo(LIFECYCLE.patchStaleDays + 1), NOW)).toMatchObject({ result: 'fail', reason: 'patch_stale' });
    expect(checkPatch('o1', daysAgo(LIFECYCLE.patchStaleDays - 1), NOW)).toMatchObject({ result: 'pass', reason: 'patched' });
    expect(checkPatch('o1', null, NOW).result).toBe('not_applicable');
    expect(checkPatch('o1', 'not a date', NOW).result).toBe('not_applicable');
  });

  it('hardware: a past end of support fails, a future one passes, none is not applicable', () => {
    expect(checkHardware('a', '2025-01-31', 'vendor', NOW).result).toBe('fail');
    expect(checkHardware('a', '2030-01-31', 'vendor', NOW).result).toBe('pass');
    expect(checkHardware('a', null, null, NOW).result).toBe('not_applicable');
  });

  it('certificates: expired fails validity, a weakness fails strength, no notAfter skips validity', () => {
    const [validity, strength] = checkCertificate('c', { notAfter: daysAgo(1), daysLeft: -1, expired: true, weaknesses: ['rsa_1024'], subject: 'CN=old' });
    expect(validity).toMatchObject({ check: 'certificate_valid', result: 'fail', reason: 'certificate_expired' });
    expect(strength).toMatchObject({ check: 'certificate_strong', result: 'fail', facts: { weaknesses: 'rsa_1024' } });
    expect(checkCertificate('c', { notAfter: null, daysLeft: null, expired: false, weaknesses: [], subject: 'CN=x' }).map((o) => o.check)).toEqual(['certificate_strong']);
  });

  it('TLS: below the minimum fails, the minimum and newer pass, unknown is not applicable', () => {
    expect(checkTls('l', 'TLS 1.0', 'web:443').result).toBe('fail');
    expect(checkTls('l', 'TLS 1.1', null).result).toBe('fail');
    expect(checkTls('l', COMPLIANCE.minTlsVersion, null).result).toBe('pass');
    expect(checkTls('l', 'TLSv1.3', null).result).toBe('pass');
    expect(checkTls('l', 'unknown', null).result).toBe('not_applicable');
    expect(tlsRank(null)).toBe(-1);
  });

  it('storage, shares and buckets: decided from the attribute the collector writes', () => {
    expect(checkStorageEncryption('s', { encryptionAtRest: true }).result).toBe('pass');
    expect(checkStorageEncryption('s', { encryptionAtRest: false }).result).toBe('fail');
    expect(checkStorageEncryption('s', { encryption: 'SSE-KMS' }).result).toBe('pass');
    expect(checkStorageEncryption('s', { encryption: 'none' }).result).toBe('fail');
    expect(checkStorageEncryption('s', {}).result).toBe('not_applicable');
    expect(checkShareEncryption('n', 'smb', ['encrypt']).result).toBe('pass');
    expect(checkShareEncryption('n', 'smb', []).result).toBe('fail');
    expect(checkShareEncryption('n', 'nfs', ['rw', 'sec=krb5p']).result).toBe('pass');
    expect(checkShareEncryption('n', 'nfs', ['rw', 'sec=sys']).result).toBe('fail');
    expect(checkShareEncryption('n', 'afp', []).result).toBe('not_applicable');
    expect(checkBucketPublic('b', false)?.result).toBe('fail');
    expect(checkBucketPublic('b', true)?.result).toBe('pass');
    expect(checkBucketPublic('b', null)).toBeNull();
  });

  it('backups: a database past the window fails; the deployment needs a recent, encrypted complete set', () => {
    expect(checkDatabaseBackup('d', hoursAgo(COMPLIANCE.databaseBackupMaxAgeHours + 1), NOW).result).toBe('fail');
    expect(checkDatabaseBackup('d', hoursAgo(1), NOW).result).toBe('pass');
    expect(checkDatabaseBackup('d', null, NOW).result).toBe('not_applicable');
    const base = { configured: true, stale: false, lastCompleteAt: hoursAgo(1), newestEncrypted: true, staleAfterHours: 26 };
    expect(checkPlatformBackup(base).result).toBe('pass');
    expect(checkPlatformBackup({ ...base, configured: false })).toMatchObject({ result: 'fail', reason: 'platform_backup_missing', ciId: null });
    expect(checkPlatformBackup({ ...base, stale: true }).reason).toBe('platform_backup_stale');
    expect(checkPlatformBackup({ ...base, newestEncrypted: false }).reason).toBe('platform_backup_unencrypted');
  });

  it('firewalls: any permissive rule fails', () => {
    expect(checkFirewall('f', 12, 1, false).result).toBe('fail');
    expect(checkFirewall('f', 12, 0, false).result).toBe('pass');
  });
});

describe('posture', () => {
  const o = (check: ComplianceOutcome['check'], ciId: string | null, result: ComplianceOutcome['result']): ComplianceOutcome => ({ check, ciId, result, reason: 'encrypted', facts: {} });

  it('pass rate is passed / (passed + failed); a control fails on any failure; high-risk CIs need a failure and a high CVE', () => {
    const outcomes = [
      o('cve_high_critical', 'host-a', 'fail'),
      o('cve_high_critical', 'host-b', 'pass'),
      o('release_supported', 'os-b', 'fail'), // installed on host-b, which has no high CVE
      o('release_supported', 'os-c', 'fail'), // installed on host-c, which has one (a medium-only CVE check passed elsewhere)
      o('tls_modern', 'tls-1', 'pass'),
      o('tls_modern', 'tls-2', 'not_applicable'),
    ];
    const exposed = new Set(['host-a', 'host-c']);
    const anchors = new Map([
      ['os-b', 'host-b'],
      ['os-c', 'host-c'],
    ]);
    const posture = compliancePosture(outcomes, exposed, anchors);
    const iso = posture.find((p) => p.framework === 'iso27001');
    // A.8.8 uses cve_high_critical and release_supported; A.8.24 uses tls_modern.
    expect(iso?.evaluations).toEqual({ passed: 2, failed: 3, notApplicable: 1 });
    expect(iso?.passRate).toBeCloseTo(2 / 5);
    expect(iso?.controls.find((c) => c.controlId === 'A.8.8')).toMatchObject({ result: 'fail', tally: { passed: 1, failed: 3, notApplicable: 0 } });
    expect(iso?.controls.find((c) => c.controlId === 'A.8.24')).toMatchObject({ result: 'pass' });
    expect(iso?.controls.find((c) => c.controlId === 'A.8.13')).toMatchObject({ result: 'not_applicable' });
    expect(iso?.highRiskCis).toBe(2);
    // PCI 4.2.1 has the TLS check, 11.3.1 the CVE check, 12.3.4 the release check.
    const pci = posture.find((p) => p.framework === 'pci_dss');
    expect(pci?.controlsFailed).toBe(2);
    expect(pci?.controlsPassed).toBe(1);
  });

  it('nothing evaluated means no pass rate rather than zero or one hundred percent', () => {
    expect(passRate({ passed: 0, failed: 0, notApplicable: 4 })).toBeNull();
    expect(compliancePosture([], new Set(), new Map()).every((p) => p.passRate === null && p.highRiskCis === 0)).toBe(true);
  });

  it('CVE risk counts distinct CVEs and the CIs exposed to a high or critical one', () => {
    const risk = cveRisk(
      new Map([
        ['h1', [cve('CVE-1', 'critical', 9.8, true), cve('CVE-2', 'high', 7.1)]],
        ['h2', [cve('CVE-1', 'critical', 9.8, true)]],
        ['h3', [cve('CVE-3', 'low', 3.1)]],
      ]),
    );
    expect(risk).toEqual({ critical: 1, high: 1, exploited: 1, exposedCis: 2 });
  });
});
