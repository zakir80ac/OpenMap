'use client';
// REQ-SEC-001 REQ-SEC-009 — browser session: OIDC Authorization Code + PKCE against the Keycloak realm, tokens held
// in memory, the refresh token mirrored to sessionStorage so a reload restores the session, silent renewal before
// expiry, RP-initiated logout, and the access-token hooks the GraphQL transport uses. Navigation, fetch and the clock
// are injectable so the whole flow runs under test without a browser redirect.
import type { Role } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { setAuthHooks } from '@/lib/graphql';
import { localizedHref } from '@/lib/locale-path';
import { authConfig, callbackUri } from './config';
import { loadDiscovery, type FetchLike } from './discovery';
import {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  decodeJwtPayload,
  discoveryDocumentUrl,
  displayName,
  realmRoles,
  refreshDelayMs,
  safeReturnPath,
  type CallbackParams,
  type JwtClaims,
  type OidcDiscovery,
  type TokenSet,
} from './oidc';
import { codeChallenge, createCodeVerifier, createNonce, createState } from './pkce';
import { hasRole } from './roles';
import { clearPending, readPending, readRefreshToken, savePending, writeRefreshToken } from './storage';
import { exchangeCode, refreshGrant } from './token-client';

export type AuthStatus = 'restoring' | 'signed-out' | 'signed-in';

/** Why the user is signed out, when it was not their choice; the sign-in screen words it. */
export type AuthReason = 'expired' | 'rejected' | 'unavailable' | 'misconfigured';

export type CallbackErrorCode = 'denied' | 'state_mismatch' | 'missing_code' | 'nonce_mismatch' | 'exchange_failed' | 'unavailable';

export class CallbackError extends Error {
  constructor(
    public readonly code: CallbackErrorCode,
    detail?: string,
  ) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'CallbackError';
  }
}

export interface AuthUser {
  subject: string;
  username: string;
  displayName: string;
  email: string | undefined;
  tenant: string | undefined;
  roles: string[];
}

export interface AuthValue {
  status: AuthStatus;
  user: AuthUser | undefined;
  reason: AuthReason | undefined;
  /** The server's own wording when the reason is `rejected` (shown verbatim under the translated reason). */
  reasonDetail: string | undefined;
  /** Whether the signed-in user holds the role (after implication). False when signed out. */
  can: (role: Role) => boolean;
  getAccessToken: () => string | undefined;
  /** Starts the Authorization Code flow; the browser leaves for the identity provider. */
  signIn: AsyncAction<[returnTo?: string]>;
  /** Finishes the flow on the callback route; resolves to the path to return to. */
  completeSignIn: AsyncAction<[params: CallbackParams], string>;
  /** Clears the local session and sends the browser to Keycloak's end_session endpoint. */
  signOut: AsyncAction;
}

/**
 * Promise-returning callback type spelled as a call signature. Written this way so the guard's JSX-text rule, which
 * scans .tsx files line by line, does not misread an arrow-function type as untranslated text.
 */
export interface AsyncAction<TArgs extends unknown[] = [], TResult = void> {
  (...args: TArgs): Promise<TResult>;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);

export interface AuthProviderProps {
  locale: Locale;
  children: ReactNode;
  /** Full-page navigation; defaults to window.location.assign. */
  navigate?: (url: string) => void;
  fetchImpl?: FetchLike;
  now?: () => number;
}

function userFromTokens(tokens: TokenSet): AuthUser {
  let claims: JwtClaims = {};
  try {
    claims = decodeJwtPayload(tokens.idToken ?? tokens.accessToken);
  } catch {
    claims = {};
  }
  // Realm roles are on the access token; the id token carries them too through the realm mapper, so merge both.
  let accessClaims: JwtClaims = {};
  try {
    accessClaims = decodeJwtPayload(tokens.accessToken);
  } catch {
    accessClaims = {};
  }
  const subject = claims.sub ?? accessClaims.sub ?? '';
  return {
    subject,
    username: claims.preferred_username ?? accessClaims.preferred_username ?? subject,
    displayName: displayName({ ...accessClaims, ...claims }),
    email: claims.email ?? accessClaims.email,
    tenant: claims.tenant ?? accessClaims.tenant,
    roles: [...new Set([...realmRoles(claims), ...realmRoles(accessClaims)])].sort(),
  };
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

function currentOrigin(): string {
  return window.location.origin;
}

export function AuthProvider({ locale, children, navigate = defaultNavigate, fetchImpl = fetch, now = Date.now }: AuthProviderProps): ReactNode {
  const tokensRef = useRef<TokenSet | undefined>(undefined);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Server rendering and the first client render must agree, and only the browser knows whether a refresh token is
  // stored, so every mount starts in `restoring`; the mount effect below settles it to signed-out or signed-in.
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [user, setUser] = useState<AuthUser | undefined>(undefined);
  const [reason, setReason] = useState<AuthReason | undefined>(undefined);
  const [reasonDetail, setReasonDetail] = useState<string | undefined>(undefined);

  const discovery = useCallback((): Promise<OidcDiscovery> => {
    const config = authConfig();
    return loadDiscovery(discoveryDocumentUrl(config.keycloakUrl, config.realm), fetchImpl);
  }, [fetchImpl]);

  const clearSession = useCallback((why: AuthReason | undefined, detail?: string): void => {
    if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current);
    refreshTimer.current = undefined;
    tokensRef.current = undefined;
    writeRefreshToken(undefined);
    setUser(undefined);
    setReason(why);
    setReasonDetail(detail);
    setStatus('signed-out');
  }, []);

  // applyTokens schedules renew and renew calls applyTokens; the ref breaks the cycle without a stale closure.
  const renewRef = useRef<AsyncAction>(() => Promise.resolve());
  const renew = useCallback((): Promise<void> => renewRef.current(), []);

  const applyTokens = useCallback(
    (tokens: TokenSet): void => {
      tokensRef.current = tokens;
      writeRefreshToken(tokens.refreshToken);
      setUser(userFromTokens(tokens));
      setReason(undefined);
      setReasonDetail(undefined);
      setStatus('signed-in');
      if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = undefined;
        void renew();
      }, refreshDelayMs(tokens.expiresAtMs, now()));
    },
    [now, renew],
  );

  useEffect(() => {
    renewRef.current = async (): Promise<void> => {
      const refreshToken = tokensRef.current?.refreshToken ?? readRefreshToken();
      if (refreshToken === undefined) {
        clearSession('expired');
        return;
      }
      try {
        const config = authConfig();
        const doc = await discovery();
        const tokens = await refreshGrant({ tokenEndpoint: doc.tokenEndpoint, clientId: config.clientId, refreshToken }, now(), fetchImpl);
        applyTokens(tokens);
      } catch {
        clearSession('expired');
      }
    };
  }, [applyTokens, clearSession, discovery, fetchImpl, now]);

  // Restore a session after a reload: the refresh token in sessionStorage is exchanged for a fresh token set.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (readRefreshToken() === undefined) setStatus('signed-out');
    else void renew();
    return () => {
      if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current);
    };
  }, [renew]);

  const getAccessToken = useCallback((): string | undefined => tokensRef.current?.accessToken, []);
  const can = useCallback((role: Role): boolean => user !== undefined && hasRole(user.roles, role), [user]);

  const signIn = useCallback(
    async (returnTo?: string): Promise<void> => {
      const home = localizedHref(locale, '/');
      try {
        const config = authConfig();
        const doc = await discovery();
        const codeVerifier = createCodeVerifier();
        const state = createState();
        const nonce = createNonce();
        savePending({ state, codeVerifier, nonce, returnTo: safeReturnPath(returnTo, home), locale });
        navigate(
          buildAuthorizeUrl({
            authorizationEndpoint: doc.authorizationEndpoint,
            clientId: config.clientId,
            redirectUri: callbackUri(currentOrigin(), locale),
            state,
            nonce,
            codeChallenge: await codeChallenge(codeVerifier),
            uiLocale: locale,
          }),
        );
      } catch (error) {
        clearSession(error instanceof Error && error.message.includes('is not set') ? 'misconfigured' : 'unavailable');
      }
    },
    [clearSession, discovery, locale, navigate],
  );

  const completeSignIn = useCallback(
    async (params: CallbackParams): Promise<string> => {
      const home = localizedHref(locale, '/');
      if (params.error !== undefined) {
        clearPending();
        throw new CallbackError('denied', params.errorDescription ?? params.error);
      }
      const pending = readPending();
      if (pending === undefined || params.state === undefined || pending.state !== params.state) {
        clearPending();
        throw new CallbackError('state_mismatch');
      }
      if (params.code === undefined) {
        clearPending();
        throw new CallbackError('missing_code');
      }
      let doc: OidcDiscovery;
      let clientId: string;
      try {
        clientId = authConfig().clientId;
        doc = await discovery();
      } catch (error) {
        throw new CallbackError('unavailable', error instanceof Error ? error.message : undefined);
      }
      let tokens: TokenSet;
      try {
        tokens = await exchangeCode(
          { tokenEndpoint: doc.tokenEndpoint, clientId, code: params.code, codeVerifier: pending.codeVerifier, redirectUri: callbackUri(currentOrigin(), pending.locale) },
          now(),
          fetchImpl,
        );
      } catch (error) {
        clearPending();
        throw new CallbackError('exchange_failed', error instanceof Error ? error.message : undefined);
      }
      clearPending();
      if (tokens.idToken !== undefined) {
        let nonce: string | undefined;
        try {
          nonce = decodeJwtPayload(tokens.idToken).nonce;
        } catch {
          nonce = undefined;
        }
        if (nonce !== pending.nonce) throw new CallbackError('nonce_mismatch');
      }
      applyTokens(tokens);
      return safeReturnPath(pending.returnTo, home);
    },
    [applyTokens, discovery, fetchImpl, locale, now],
  );

  const signOut = useCallback(async (): Promise<void> => {
    const idToken = tokensRef.current?.idToken;
    const home = currentOrigin() + localizedHref(locale, '/');
    clearSession(undefined);
    try {
      const config = authConfig();
      const doc = await discovery();
      if (doc.endSessionEndpoint === undefined) {
        navigate(home);
        return;
      }
      navigate(buildEndSessionUrl({ endSessionEndpoint: doc.endSessionEndpoint, clientId: config.clientId, postLogoutRedirectUri: home, idToken }));
    } catch {
      navigate(home);
    }
  }, [clearSession, discovery, locale, navigate]);

  // Hand the transport its token source. A rejected token ends the session and the sign-in screen says why, with the
  // API's own wording; it never restarts sign-in on its own, because an identity provider with a live SSO session
  // would bounce the browser straight back with a new token the API rejects again, in a silent loop.
  useEffect(() => {
    setAuthHooks({
      getAccessToken,
      onUnauthorized: (error) => {
        if (tokensRef.current === undefined) return;
        clearSession('rejected', error.message);
      },
    });
    return () => {
      setAuthHooks(undefined);
    };
  }, [clearSession, getAccessToken]);

  const value = useMemo<AuthValue>(
    () => ({ status, user, reason, reasonDetail, can, getAccessToken, signIn, completeSignIn, signOut }),
    [status, user, reason, reasonDetail, can, getAccessToken, signIn, completeSignIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === undefined) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** The role check alone, for screens that gate an action on the signed-in user's roles. */
export function useCan(): (role: Role) => boolean {
  return useAuth().can;
}
