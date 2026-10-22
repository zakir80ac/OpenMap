// REQ-SEC-009 — sessionStorage wrappers behind try/catch (private windows, blocked storage and server rendering all
// degrade to "nothing stored"), plus the two records the flow keeps: the refresh token and the pending request.
import { AUTH } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function readSession(key: string): string | undefined {
  try {
    const value = storage()?.getItem(key);
    return value === null || value === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}

export function writeSession(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Storage unavailable: the session then lives in memory only and a reload signs the user in again.
  }
}

export function removeSession(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to remove when storage is unavailable.
  }
}

export function readRefreshToken(): string | undefined {
  return readSession(AUTH.storageKeys.refresh);
}

export function writeRefreshToken(value: string | undefined): void {
  if (value === undefined) removeSession(AUTH.storageKeys.refresh);
  else writeSession(AUTH.storageKeys.refresh, value);
}

/** Everything needed to finish an authorization request when the browser returns from the identity provider. */
export interface PendingAuth {
  state: string;
  codeVerifier: string;
  nonce: string;
  /** Same-origin path to return to after sign-in (validated again by safeReturnPath before navigating). */
  returnTo: string;
  locale: Locale;
}

export function savePending(pending: PendingAuth): void {
  writeSession(AUTH.storageKeys.pending, JSON.stringify(pending));
}

export function readPending(): PendingAuth | undefined {
  const raw = readSession(AUTH.storageKeys.pending);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const { state, codeVerifier, nonce, returnTo, locale } = record;
    if ([state, codeVerifier, nonce, returnTo, locale].some((v) => typeof v !== 'string')) return undefined;
    return { state, codeVerifier, nonce, returnTo, locale } as PendingAuth;
  } catch {
    return undefined;
  }
}

export function clearPending(): void {
  removeSession(AUTH.storageKeys.pending);
}
