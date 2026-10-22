// T-080 REQ-SEC-001 REQ-SEC-009 — PKCE helpers: base64url codec, verifier shape, the RFC 7636 S256 test vector,
// and unpredictable state and nonce values.
import { AUTH } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { base64UrlDecode, base64UrlEncode, codeChallenge, createCodeVerifier, createNonce, createState, randomUrlSafe } from './pkce';

const URL_SAFE = /^[A-Za-z0-9_-]+$/;

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding characters', () => {
    const text = 'OpenMap · أوبن ماب';
    const encoded = base64UrlEncode(new TextEncoder().encode(text));
    expect(encoded).toMatch(URL_SAFE);
    expect(base64UrlDecode(encoded)).toBe(text);
  });
  it('accepts padded input as well', () => {
    expect(base64UrlDecode('YQ==')).toBe('a');
    expect(base64UrlDecode('YQ')).toBe('a');
    expect(base64UrlDecode('YWI')).toBe('ab');
  });
});

describe('code verifier and challenge', () => {
  it('produces a verifier within the RFC 7636 length bounds using only unreserved characters', () => {
    const verifier = createCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(URL_SAFE);
    expect(createCodeVerifier()).not.toBe(verifier);
  });
  it('derives the S256 challenge from RFC 7636 appendix B', async () => {
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('encodes the configured number of random bytes', () => {
    // 3 bytes become 4 characters; the configured sizes are multiples of 3 or leave a predictable remainder.
    const expectedLength = (bytes: number): number => Math.ceil((bytes * 8) / 6);
    expect(randomUrlSafe(AUTH.stateBytes)).toHaveLength(expectedLength(AUTH.stateBytes));
    expect(createState()).toHaveLength(expectedLength(AUTH.stateBytes));
    expect(createNonce()).toHaveLength(expectedLength(AUTH.nonceBytes));
    expect(createState()).not.toBe(createState());
    expect(createNonce()).not.toBe(createNonce());
  });
});
