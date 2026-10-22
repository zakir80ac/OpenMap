// T-083 REQ-SEC-001 REQ-SEC-009 — AuthProvider: session restore from the stored refresh token, identity derived from
// the id token, silent renewal before expiry (fake timers), sign-in redirect with PKCE, callback completion with
// state and nonce checks, sign-out through end_session, and the hooks the GraphQL transport receives.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { AUTH } from '@openmap/constants';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { gql } from '@/lib/graphql';
import { AuthProvider, useAuth, type AuthValue } from './AuthProvider';
import { resetDiscoveryCache } from './discovery';
import { AUTHORIZE_URL, CLIENT_ID, createIdpStub, END_SESSION_URL, installAuthEnv, tokenCalls, tokenResponse, type IdpStub } from './__tests__/helpers';
import { readPending, readRefreshToken, savePending } from './storage';

let latest: AuthValue | undefined;

function Probe(): ReactNode {
  const auth = useAuth();
  latest = auth;
  return (
    <div>
      <output data-testid="status">{auth.status}</output>
      <output data-testid="user">{auth.user?.displayName ?? ''}</output>
      <output data-testid="reason">{auth.reason ?? ''}</output>
    </div>
  );
}

let idp: IdpStub;
let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;
const NOW = 1_700_000_000_000;

/** Real macrotask yield captured before any fake timers are installed, so async fetch chains settle under fake time. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const settle = (): Promise<void> =>
  act(
    () =>
      new Promise<void>((resolve) => {
        realSetTimeout(resolve, 0);
      }),
  );

function mount(): void {
  render(
    <Providers locale="en">
      <AuthProvider locale="en" navigate={navigate} fetchImpl={idp.fetch} now={() => Date.now()}>
        <Probe />
      </AuthProvider>
    </Providers>,
  );
}

beforeEach(() => {
  installAuthEnv();
  resetDiscoveryCache();
  sessionStorage.clear();
  idp = createIdpStub();
  navigate = vi.fn<(url: string) => void>();
  latest = undefined;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const status = (): string => screen.getByTestId('status').textContent;

describe('AuthProvider', () => {
  it('starts signed out when nothing is stored and installs no bearer token', () => {
    mount();
    expect(status()).toBe('signed-out');
    expect(latest?.getAccessToken()).toBeUndefined();
    expect(idp.calls).toHaveLength(0);
  });

  it('restores a session from the stored refresh token, derives the user and renews before expiry', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    sessionStorage.setItem(AUTH.storageKeys.refresh, 'refresh-stored');
    mount();
    expect(status()).toBe('restoring');
    await settle();
    await settle();
    expect(status()).toBe('signed-in');
    const first = tokenCalls(idp)[0];
    expect(first?.body?.get('grant_type')).toBe('refresh_token');
    expect(first?.body?.get('refresh_token')).toBe('refresh-stored');
    expect(first?.body?.get('client_id')).toBe(CLIENT_ID);
    expect(first?.headers['content-type']).toBe('application/x-www-form-urlencoded');

    expect(latest?.user).toMatchObject({ username: 'admin', displayName: 'OpenMap Admin', tenant: 'default', email: 'admin@openmap.local' });
    expect(latest?.user?.roles).toEqual(['offline_access', 'openmap-admin']);
    expect(readRefreshToken()).toBe('refresh-initial');
    const firstAccess = latest?.getAccessToken();
    expect(firstAccess).toBeDefined();

    // 900 s lifetime: renewal fires refreshLeadMs before expiry, not earlier.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900_000 - AUTH.refreshLeadMs - 1_000);
    });
    expect(tokenCalls(idp)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await settle();
    await settle();
    expect(tokenCalls(idp)).toHaveLength(2);
    expect(tokenCalls(idp)[1]?.body?.get('refresh_token')).toBe('refresh-initial');
    expect(latest?.getAccessToken()).not.toBe(firstAccess);
    expect(readRefreshToken()).toBe('refresh-1');
    expect(status()).toBe('signed-in');
  });

  it('signs out with the expired reason when renewal is refused', async () => {
    sessionStorage.setItem(AUTH.storageKeys.refresh, 'refresh-stale');
    idp.tokenHandler = () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token is not active' }), { status: 400, headers: { 'content-type': 'application/json' } });
    mount();
    await waitFor(() => {
      expect(status()).toBe('signed-out');
    });
    expect(screen.getByTestId('reason').textContent).toBe('expired');
    expect(readRefreshToken()).toBeUndefined();
  });

  it('signIn stores the pending request and leaves for the authorize endpoint with S256 PKCE', async () => {
    mount();
    await act(async () => {
      await latest?.signIn('/en/cmdb?q=db');
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    const url = new URL(navigate.mock.calls[0]?.[0] ?? '');
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(window.location.origin + '/en/auth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('ui_locales')).toBe('en');
    const pending = readPending();
    expect(pending?.state).toBe(url.searchParams.get('state'));
    expect(pending?.nonce).toBe(url.searchParams.get('nonce'));
    expect(pending?.returnTo).toBe('/en/cmdb?q=db');
    expect(pending?.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('completeSignIn exchanges the code with the stored verifier, checks the nonce and returns the saved path', async () => {
    savePending({ state: 'st-1', codeVerifier: 'verifier-1', nonce: 'nonce-1', returnTo: '/en/services', locale: 'en' });
    idp.tokenHandler = () => new Response(JSON.stringify(tokenResponse({ ...{ sub: 's', preferred_username: 'ops', name: 'Ops User', tenant: 'acme', roles: ['openmap-operator'] }, nonce: 'nonce-1' })), { status: 200, headers: { 'content-type': 'application/json' } });
    mount();
    let returnTo = '';
    await act(async () => {
      returnTo = (await latest?.completeSignIn({ code: 'code-1', state: 'st-1', error: undefined, errorDescription: undefined })) ?? '';
    });
    expect(returnTo).toBe('/en/services');
    const call = tokenCalls(idp)[0];
    expect(call?.body?.get('grant_type')).toBe('authorization_code');
    expect(call?.body?.get('code')).toBe('code-1');
    expect(call?.body?.get('code_verifier')).toBe('verifier-1');
    expect(call?.body?.get('redirect_uri')).toBe(window.location.origin + '/en/auth/callback');
    expect(status()).toBe('signed-in');
    expect(latest?.user).toMatchObject({ displayName: 'Ops User', tenant: 'acme', roles: ['openmap-operator'] });
    expect(readPending()).toBeUndefined();
  });

  it('completeSignIn rejects a state that does not match the pending request', async () => {
    savePending({ state: 'st-1', codeVerifier: 'v', nonce: 'n', returnTo: '/en', locale: 'en' });
    mount();
    await expect(latest?.completeSignIn({ code: 'c', state: 'st-other', error: undefined, errorDescription: undefined })).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(tokenCalls(idp)).toHaveLength(0);
    expect(status()).toBe('signed-out');
  });

  it('completeSignIn rejects an id token whose nonce was not issued for this request', async () => {
    savePending({ state: 'st-1', codeVerifier: 'v', nonce: 'expected', returnTo: '/en', locale: 'en' });
    idp.tokenHandler = () => new Response(JSON.stringify(tokenResponse({ sub: 's', nonce: 'other' })), { status: 200, headers: { 'content-type': 'application/json' } });
    mount();
    await expect(latest?.completeSignIn({ code: 'c', state: 'st-1', error: undefined, errorDescription: undefined })).rejects.toMatchObject({ code: 'nonce_mismatch' });
    expect(status()).toBe('signed-out');
  });

  it('completeSignIn surfaces a provider error as denied', async () => {
    mount();
    await expect(latest?.completeSignIn({ code: undefined, state: 's', error: 'access_denied', errorDescription: 'User cancelled' })).rejects.toMatchObject({ code: 'denied' });
  });

  it('signOut clears the session and navigates to end_session with id_token_hint and the post-logout URI', async () => {
    sessionStorage.setItem(AUTH.storageKeys.refresh, 'refresh-stored');
    mount();
    await waitFor(() => {
      expect(status()).toBe('signed-in');
    });
    await act(async () => {
      await latest?.signOut();
    });
    expect(status()).toBe('signed-out');
    expect(readRefreshToken()).toBeUndefined();
    const url = new URL(navigate.mock.calls[0]?.[0] ?? '');
    expect(url.origin + url.pathname).toBe(END_SESSION_URL);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(window.location.origin + '/en');
    expect(url.searchParams.get('id_token_hint')).toBeTruthy();
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
  });

  it('gives gql() the bearer token and signs out with the rejected reason and the API wording when the API rejects it', async () => {
    sessionStorage.setItem(AUTH.storageKeys.refresh, 'refresh-stored');
    mount();
    await waitFor(() => {
      expect(status()).toBe('signed-in');
    });
    const token = latest?.getAccessToken();
    const apiCalls: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        apiCalls.push((init?.headers as Record<string, string> | undefined) ?? {});
        return Promise.resolve(new Response(JSON.stringify({ data: null, errors: [{ message: 'a bearer token is required' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }),
    );
    await act(async () => {
      await gql('query Layers { layers { layer } }').catch(() => undefined);
    });
    vi.unstubAllGlobals();
    expect(apiCalls[0]?.['authorization']).toBe('Bearer ' + String(token));
    await waitFor(() => {
      expect(status()).toBe('signed-out');
    });
    expect(screen.getByTestId('reason').textContent).toBe('rejected');
    expect(latest?.reasonDetail).toBe('a bearer token is required');
    // No automatic restart: with a live SSO session that would loop silently while the API keeps rejecting tokens.
    expect(navigate).not.toHaveBeenCalled();
  });
});
