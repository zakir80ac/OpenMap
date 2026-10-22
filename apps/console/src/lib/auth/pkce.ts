// REQ-SEC-001 REQ-SEC-009 — PKCE (RFC 7636) and random-parameter helpers over WebCrypto: base64url codec, code
// verifier and S256 challenge, state and nonce. Pure functions, no DOM, so they are unit-tested directly.
import { AUTH } from '@openmap/constants';

/** Base64url without padding (RFC 4648 §5), the alphabet PKCE, state and JWT segments use. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url (padded or not) to a UTF-8 string; used for JWT payloads. Throws on malformed input. */
export function base64UrlDecode(text: string): string {
  const remainder = text.length % AUTH.base64BlockLength;
  const padding = remainder === 0 ? '' : '='.repeat(AUTH.base64BlockLength - remainder);
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + padding;
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Cryptographically random bytes, base64url-encoded. */
export function randomUrlSafe(byteLength: number): string {
  const buffer = new Uint8Array(byteLength);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}

export function createCodeVerifier(): string {
  return randomUrlSafe(AUTH.pkceVerifierBytes);
}

export function createState(): string {
  return randomUrlSafe(AUTH.stateBytes);
}

export function createNonce(): string {
  return randomUrlSafe(AUTH.nonceBytes);
}

/** S256 code challenge: base64url(SHA-256(verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(AUTH.challengeHash, new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
