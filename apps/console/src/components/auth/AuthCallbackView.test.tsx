// T-084 REQ-SEC-001 — the callback view in en and ar: a state mismatch shows the translated error with a retry that
// starts the flow again; a valid callback completes and returns the browser to the requested route.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth/AuthProvider';
import { resetDiscoveryCache } from '@/lib/auth/discovery';
import { savePending } from '@/lib/auth/storage';
import { AUTHORIZE_URL, createIdpStub, installAuthEnv, tokenResponse, type IdpStub } from '@/lib/auth/__tests__/helpers';
import { Providers } from '@/providers';
import { AuthCallbackView } from './AuthCallbackView';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/en/auth/callback',
}));

let idp: IdpStub;
let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;

beforeEach(() => {
  installAuthEnv();
  resetDiscoveryCache();
  sessionStorage.clear();
  router.replace.mockReset();
  idp = createIdpStub();
  navigate = vi.fn<(url: string) => void>();
});

afterEach(() => {
  cleanup();
});

describe.each(LOCALES)('AuthCallbackView in %s', (locale) => {
  it('shows the state-mismatch error and retries sign-in from the beginning', async () => {
    savePending({ state: 'expected', codeVerifier: 'v', nonce: 'n', returnTo: '/' + locale + '/cmdb', locale });
    render(
      <Providers locale={locale}>
        <AuthProvider locale={locale} navigate={navigate} fetchImpl={idp.fetch}>
          <AuthCallbackView locale={locale} search="?code=abc&state=tampered" />
        </AuthProvider>
      </Providers>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(translate(locale, 'auth.callback.stateMismatch'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translate(locale, 'auth.callback.failedTitle'));
    expect(router.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'common.retry') }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(1);
    });
    const url = new URL(navigate.mock.calls[0]?.[0] ?? '');
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get('redirect_uri')).toBe(window.location.origin + '/' + locale + '/auth/callback');
  });

  it('exchanges a valid code and returns to the requested route', async () => {
    savePending({ state: 'st', codeVerifier: 'v', nonce: 'n', returnTo: '/' + locale + '/services', locale });
    idp.tokenHandler = () => new Response(JSON.stringify(tokenResponse({ sub: 's', preferred_username: 'admin', tenant: 'default', roles: [], nonce: 'n' })), { status: 200, headers: { 'content-type': 'application/json' } });
    render(
      <Providers locale={locale}>
        <AuthProvider locale={locale} navigate={navigate} fetchImpl={idp.fetch}>
          <AuthCallbackView locale={locale} search="?code=abc&state=st" />
        </AuthProvider>
      </Providers>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translate(locale, 'auth.callback.completing'));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/' + locale + '/services');
    });
    expect(screen.getByRole('status').textContent).toContain(translate(locale, 'auth.callback.done'));
  });
});
