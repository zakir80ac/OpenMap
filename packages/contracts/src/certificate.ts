// REQ-CMDB-032 (ADR-036) — certificates as the certificate collector reports them (one `certificate` CI per
// fingerprint; a TLS `listening_service` is `secured_by` its leaf; a certificate `depends_on` its issuer), read the same
// way by the API's register and the expiry watcher: days left from `notAfter` (never the collector's stale count),
// the alert threshold a certificate has reached, and whether its key or signature is weak.
import { z } from 'zod';

export const CERTIFICATE_ATTRIBUTES = {
  subject: 'subject',
  issuer: 'issuer',
  serial: 'serial',
  notBefore: 'notBefore',
  notAfter: 'notAfter',
  dnsNames: 'dnsNames',
  ipAddresses: 'ipAddresses',
  keyAlgorithm: 'keyAlgorithm',
  keyBits: 'keyBits',
  signatureAlgorithm: 'signatureAlgorithm',
  isCa: 'isCa',
  selfSigned: 'selfSigned',
  fingerprint: 'fingerprintSha256',
} as const;

const MS_PER_DAY = 86_400_000;

/** Whole days from `now` to `notAfter`, rounded down (a certificate expiring in 23 hours has 0 days left). */
export function certificateDaysLeft(notAfter: string, now: Date): number {
  return Math.floor((Date.parse(notAfter) - now.getTime()) / MS_PER_DAY);
}

/**
 * The alert threshold a certificate with `daysLeft` has reached: the smallest configured threshold at or above it, or
 * 0 once expired; null while it is further out than every threshold. A certificate first seen inside a threshold
 * alerts for that threshold only, not for the larger ones it already passed.
 */
export function certificateThreshold(daysLeft: number, thresholdsDays: readonly number[]): number | null {
  if (daysLeft < 0) return 0;
  const reached = thresholdsDays.filter((t) => t > 0 && daysLeft <= t);
  return reached.length === 0 ? null : Math.min(...reached);
}

export interface KeyPolicy {
  minRsaBits: number;
  minEcBits: number;
  /** Lower-case fragments of signature algorithm names that are no longer collision resistant. */
  weakSignatures: readonly string[];
}

/** Why a certificate's key or signature is weak under the policy; empty when it is not. */
export function certificateWeaknesses(
  attributes: { keyAlgorithm?: unknown; keyBits?: unknown; signatureAlgorithm?: unknown },
  policy: KeyPolicy,
): Array<'short_key' | 'weak_signature'> {
  const out: Array<'short_key' | 'weak_signature'> = [];
  const algorithm = typeof attributes.keyAlgorithm === 'string' ? attributes.keyAlgorithm.toLowerCase() : '';
  const bits = typeof attributes.keyBits === 'number' ? attributes.keyBits : null;
  if (bits !== null) {
    if (algorithm.startsWith('rsa') && bits < policy.minRsaBits) out.push('short_key');
    else if ((algorithm.startsWith('ec') || algorithm.includes('ecdsa')) && bits < policy.minEcBits) out.push('short_key');
  }
  const signature = typeof attributes.signatureAlgorithm === 'string' ? attributes.signatureAlgorithm.toLowerCase() : '';
  if (policy.weakSignatures.some((w) => signature.includes(w))) out.push('weak_signature');
  return out;
}

/** Data of `openmap.certificate.expiring`: one per certificate per threshold reached (0 = expired). */
export const certificateExpiringSchema = z.object({
  ciId: z.uuid(),
  subject: z.string(),
  notAfter: z.iso.datetime({ offset: true }),
  daysLeft: z.number().int(),
  thresholdDays: z.number().int().min(0),
  expired: z.boolean(),
  endpoints: z.number().int().min(0),
});
export type CertificateExpiring = z.infer<typeof certificateExpiringSchema>;
