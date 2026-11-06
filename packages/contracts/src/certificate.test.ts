// T-186 REQ-CMDB-032 (ADR-036) — certificates offline: days left from notAfter (rounded down), the threshold reached
// (smallest at or above, 0 once expired, none when far out), and weak keys and signatures under the policy.
import { describe, expect, it } from 'vitest';
import { certificateDaysLeft, certificateExpiringSchema, certificateThreshold, certificateWeaknesses } from './certificate.js';

const thresholds = [60, 30, 14, 7, 1] as const;
const policy = { minRsaBits: 2048, minEcBits: 256, weakSignatures: ['sha1', 'md5'] };

describe('certificates', () => {
  it('counts days left and the threshold reached', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    expect(certificateDaysLeft('2026-11-07T11:00:00Z', now)).toBe(0);
    expect(certificateDaysLeft('2026-12-06T12:00:00Z', now)).toBe(30);
    expect(certificateDaysLeft('2026-11-05T12:00:00Z', now)).toBe(-1);
    expect(certificateThreshold(90, thresholds)).toBeNull();
    expect(certificateThreshold(60, thresholds)).toBe(60);
    expect(certificateThreshold(29, thresholds)).toBe(30);
    expect(certificateThreshold(5, thresholds)).toBe(7);
    expect(certificateThreshold(0, thresholds)).toBe(1);
    expect(certificateThreshold(-3, thresholds)).toBe(0);
  });

  it('flags short keys and weak signatures', () => {
    expect(certificateWeaknesses({ keyAlgorithm: 'RSA', keyBits: 1024, signatureAlgorithm: 'SHA1-RSA' }, policy)).toEqual(['short_key', 'weak_signature']);
    expect(certificateWeaknesses({ keyAlgorithm: 'RSA', keyBits: 4096, signatureAlgorithm: 'SHA256-RSA' }, policy)).toEqual([]);
    expect(certificateWeaknesses({ keyAlgorithm: 'ECDSA', keyBits: 224, signatureAlgorithm: 'ECDSA-SHA384' }, policy)).toEqual(['short_key']);
    expect(certificateWeaknesses({}, policy)).toEqual([]);
  });

  it('describes an expiry alert', () => {
    const alert = { ciId: '0b5f0a59-5d1e-4d43-9f3f-1d1f1b0f9a01', subject: 'CN=api.bank.example', notAfter: '2026-12-01T00:00:00Z', daysLeft: 25, thresholdDays: 30, expired: false, endpoints: 2 };
    expect(certificateExpiringSchema.safeParse(alert).success).toBe(true);
    expect(certificateExpiringSchema.safeParse({ ...alert, thresholdDays: -1 }).success).toBe(false);
  });
});
