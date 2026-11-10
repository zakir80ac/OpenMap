// REQ-INT-012 (ADR-073) — authenticating an inbound monitoring request against the integration's OpenBao credential.
// A request is accepted when it presents one of what the credential holds: `token` as a bearer token, `username` and
// `password` as basic credentials, `signingSecret` as an HMAC-SHA256 signature over "<timestamp>.<raw body>" (the
// ADR-065 webhook headers, timestamp in seconds, within MONITORING.signatureToleranceMs), or — only when the
// integration allows it — `token` as the last path segment. Comparisons are constant-time; pure, so it is unit-tested.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { MONITORING, NOTIFICATION, TIME } from '@openmap/constants';

export type IngestAuthMethod = 'bearer' | 'basic' | 'hmac' | 'url_token';

export interface PresentedAuth {
  authorization: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  urlToken: string | undefined;
  rawBody: string;
}

export type IngestAuthVerdict = { ok: true; method: IngestAuthMethod } | { ok: false; reason: string };

const BEARER = 'bearer ';
const BASIC = 'basic ';
const SIGNATURE_SEPARATOR = '=';

/** Equal-length digests so the comparison takes the same time whatever the presented value's length. */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

export function ingestSignature(secret: string, timestamp: string, rawBody: string): string {
  return NOTIFICATION.signatureVersion + SIGNATURE_SEPARATOR + createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

function basicPair(header: string): { user: string; pass: string } | null {
  const decoded = Buffer.from(header.slice(BASIC.length).trim(), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? null : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

export function verifyIngestAuth(
  secret: Readonly<Record<string, string>>,
  presented: PresentedAuth,
  options: { urlTokenAllowed: boolean; nowMs: number },
): IngestAuthVerdict {
  const token = secret['token'];
  const signingSecret = secret['signingSecret'];
  const username = secret['username'];
  const password = secret['password'];
  if (!present(token) && !present(signingSecret) && !(present(username) && present(password)))
    return { ok: false, reason: 'the credential holds no token, signing secret or username and password' };
  const auth = presented.authorization?.trim() ?? '';
  const lower = auth.toLowerCase();
  if (present(token) && lower.startsWith(BEARER) && constantTimeEqual(auth.slice(BEARER.length).trim(), token)) return { ok: true, method: 'bearer' };
  if (present(username) && present(password) && lower.startsWith(BASIC)) {
    const pair = basicPair(auth);
    if (pair !== null) {
      // Both halves are always compared, so a wrong user name takes as long as a wrong password.
      const userOk = constantTimeEqual(pair.user, username);
      const passOk = constantTimeEqual(pair.pass, password);
      if (userOk && passOk) return { ok: true, method: 'basic' };
    }
  }
  if (present(signingSecret) && present(presented.signature) && present(presented.timestamp)) {
    const seconds = Number(presented.timestamp);
    if (!Number.isFinite(seconds)) return { ok: false, reason: 'the signature timestamp is not a number' };
    if (Math.abs(options.nowMs - seconds * TIME.msPerSecond) > MONITORING.signatureToleranceMs) return { ok: false, reason: 'the signature timestamp is outside the tolerance' };
    if (constantTimeEqual(presented.signature, ingestSignature(signingSecret, presented.timestamp, presented.rawBody))) return { ok: true, method: 'hmac' };
    return { ok: false, reason: 'the signature does not match' };
  }
  if (options.urlTokenAllowed && present(token) && present(presented.urlToken) && constantTimeEqual(presented.urlToken, token)) return { ok: true, method: 'url_token' };
  return { ok: false, reason: 'no accepted credential was presented' };
}
