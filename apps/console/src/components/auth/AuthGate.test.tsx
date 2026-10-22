// T-085 REQ-SEC-001 REQ-UI-003 — AuthGate in en and ar: a signed-out visitor sees the branded sign-in screen (not the
// protected content) and the Sign in button starts the flow back to the current route; a restoring session shows the
// restoring frame; a signed-in session renders the children.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AUTH } from '@openmap/constants';
import { LOCALES, direction, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth/AuthProvider';
import { resetDiscoveryCache } from '@/lib/auth/discovery';
import { readPending } from '@/lib/auth/storage';
import { createIdpStub, installAuthEnv, type IdpStub } from '@/lib/auth/__tests__/helpers';
import { Providers } from '@/providers';
import { AuthGate } from './AuthGate';

const pathname = vi.hoisted(() => ({ current: '/en/dashboard' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

let idp: IdpStub;
let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;

beforeEach(() => {
  installAuthEnv();
  resetDiscoveryCache();
  sessionStorage.clear();
  idp = createIdpStub();
  navigate = vi.fn<(url: string) => void>();
});

afterEach(() => {
  cleanup();
});

describe.each(LOCALES)('AuthGate in %s', (locale) => {
  it('shows the sign-in screen instead of the protected content and starts the flow back to the current route', async () => {
    pathname.current = '/' + locale + '/impact';
    render(
      <Providers locale={locale}>
        <AuthProvider locale={locale} navigate={navigate} fetchImpl={idp.fetch}>
          <AuthGate>
            <p data-testid="protected">protected</p>
          </AuthGate>
        </AuthProvider>
      </Providers>,
    );
    expect(screen.queryByTestId('protected')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translate(locale, 'auth.signInTitle'));
    expect(screen.getByText(translate(locale, 'app.name'))).toBeTruthy();
    const panel = screen.getByRole('heading', { level: 1 }).closest('section');
    expect(panel?.getAttribute('dir')).toBe(direction(locale));

    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'auth.signIn') }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(1);
    });
    expect(readPending()?.returnTo).toBe('/' + locale + '/impact');
    expect(new URL(navigate.mock.calls[0]?.[0] ?? '').searchParams.get('ui_locales')).toBe(locale);
  });

  it('shows the restoring frame while a stored session is being renewed, then the protected content', async () => {
    sessionStorage.setItem(AUTH.storageKeys.refresh, 'refresh-stored');
    render(
      <Providers locale={locale}>
        <AuthProvider locale={locale} navigate={navigate} fetchImpl={idp.fetch}>
          <AuthGate>
            <p data-testid="protected">protected</p>
          </AuthGate>
        </AuthProvider>
      </Providers>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translate(locale, 'auth.restoring'));
    await waitFor(() => {
      expect(screen.getByTestId('protected')).toBeTruthy();
    });
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});
