// T-631 REQ-INT-012 (ADR-073) — inbound monitoring authentication (bearer, basic, HMAC with replay window, URL token
// only when allowed) and the CI choice for an alert's targets (CI id, an operator's mapping, ranked ref tokens,
// identity tokens; ambiguity leaves it unresolved).
import { describe, expect, it } from 'vitest';
import { MONITORING, TIME } from '@openmap/constants';
import { REF_TIER } from '@openmap/contracts';
import { chooseCi, type LookupIndex } from './ci-lookup.js';
import { ingestSignature, verifyIngestAuth, type PresentedAuth } from './monitoring-auth.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const BODY = '{"version":"4","alerts":[]}';
const none: PresentedAuth = { authorization: undefined, signature: undefined, timestamp: undefined, urlToken: undefined, rawBody: BODY };
const opts = { urlTokenAllowed: false, nowMs: NOW };

describe('verifyIngestAuth', () => {
  it('accepts the bearer token and refuses a wrong or missing one', () => {
    const secret = { token: 'tok-123456' };
    expect(verifyIngestAuth(secret, { ...none, authorization: 'Bearer tok-123456' }, opts)).toEqual({ ok: true, method: 'bearer' });
    expect(verifyIngestAuth(secret, { ...none, authorization: 'bearer tok-123456' }, opts)).toEqual({ ok: true, method: 'bearer' });
    expect(verifyIngestAuth(secret, { ...none, authorization: 'Bearer tok-1234567' }, opts).ok).toBe(false);
    expect(verifyIngestAuth(secret, none, opts).ok).toBe(false);
  });

  it('accepts basic credentials only when both halves match', () => {
    const secret = { username: 'orion', password: 'pa55-word' };
    const basic = (u: string, p: string): string => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
    expect(verifyIngestAuth(secret, { ...none, authorization: basic('orion', 'pa55-word') }, opts)).toEqual({ ok: true, method: 'basic' });
    expect(verifyIngestAuth(secret, { ...none, authorization: basic('orion', 'wrong') }, opts).ok).toBe(false);
    expect(verifyIngestAuth(secret, { ...none, authorization: basic('other', 'pa55-word') }, opts).ok).toBe(false);
  });

  it('verifies an HMAC signature over the timestamp and raw body inside the replay window', () => {
    const secret = { signingSecret: 'whsec-abc' };
    const ts = String(Math.floor(NOW / TIME.msPerSecond));
    const signature = ingestSignature('whsec-abc', ts, BODY);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/u);
    expect(verifyIngestAuth(secret, { ...none, signature, timestamp: ts }, opts)).toEqual({ ok: true, method: 'hmac' });
    expect(verifyIngestAuth(secret, { ...none, signature, timestamp: ts, rawBody: BODY + ' ' }, opts)).toEqual({ ok: false, reason: 'the signature does not match' });
    const old = String(Math.floor((NOW - MONITORING.signatureToleranceMs) / TIME.msPerSecond) - 1);
    expect(verifyIngestAuth(secret, { ...none, signature: ingestSignature('whsec-abc', old, BODY), timestamp: old }, opts)).toEqual({ ok: false, reason: 'the signature timestamp is outside the tolerance' });
  });

  it('takes the URL token only when the integration allows it, and refuses an empty credential', () => {
    const secret = { token: 'splunk-url-token' };
    expect(verifyIngestAuth(secret, { ...none, urlToken: 'splunk-url-token' }, opts).ok).toBe(false);
    expect(verifyIngestAuth(secret, { ...none, urlToken: 'splunk-url-token' }, { ...opts, urlTokenAllowed: true })).toEqual({ ok: true, method: 'url_token' });
    expect(verifyIngestAuth(secret, { ...none, urlToken: 'other' }, { ...opts, urlTokenAllowed: true }).ok).toBe(false);
    expect(verifyIngestAuth({}, { ...none, authorization: 'Bearer x' }, opts)).toEqual({ ok: false, reason: 'the credential holds no token, signing secret or username and password' });
  });
});

describe('chooseCi', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';
  const index: LookupIndex = {
    ciIds: new Set([C]),
    mappings: new Map([['legacy-box', B]]),
    refs: new Map([
      ['web-01.lab.test', new Map([[A, REF_TIER.identity]])],
      ['web-01', new Map([[A, REF_TIER.alias], [B, REF_TIER.alias]])],
      ['10.0.0.9', new Map([[A, REF_TIER.alias], [B, REF_TIER.identity]])],
    ]),
    identities: new Map([['sw-core', new Set([C])], ['dup', new Set([A, B])]]),
  };

  it('prefers the named CI id, then a mapping, then the lookup in target order', () => {
    expect(chooseCi([{ kind: 'ci_id', value: C }, { kind: 'fqdn', value: 'web-01.lab.test' }], index)).toEqual({ ciId: C, resolution: 'ci_id' });
    expect(chooseCi([{ kind: 'fqdn', value: 'web-01.lab.test' }, { kind: 'hostname', value: 'Legacy-Box' }], index)).toEqual({ ciId: B, resolution: 'mapping' });
    expect(chooseCi([{ kind: 'fqdn', value: 'WEB-01.lab.test' }], index)).toEqual({ ciId: A, resolution: 'identity' });
    expect(chooseCi([{ kind: 'ip', value: '10.0.0.9' }], index)).toEqual({ ciId: B, resolution: 'identity' });
    expect(chooseCi([{ kind: 'hostname', value: 'sw-core' }], index)).toEqual({ ciId: C, resolution: 'identity' });
  });

  it('leaves an alert unresolved when every value is ambiguous or unknown', () => {
    expect(chooseCi([{ kind: 'hostname', value: 'web-01' }], index)).toBeNull();
    expect(chooseCi([{ kind: 'hostname', value: 'dup' }], index)).toBeNull();
    expect(chooseCi([{ kind: 'ci_id', value: A }, { kind: 'hostname', value: 'nowhere' }], index)).toBeNull();
    expect(chooseCi([], index)).toBeNull();
  });
});
