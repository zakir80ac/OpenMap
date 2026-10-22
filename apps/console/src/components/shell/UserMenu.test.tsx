// T-086 REQ-SEC-001 REQ-UI-003 — the top-bar account menu in en and ar: opens on the avatar, shows the display name,
// username, tenant claim and every realm role as a Tag, closes on Escape, and Sign out leaves for end_session.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AUTH } from '@openmap/constants';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth/AuthProvider';
import { resetDiscoveryCache } from '@/lib/auth/discovery';
import { createIdpStub, END_SESSION_URL, installAuthEnv, type IdpStub } from '@/lib/auth/__tests__/helpers';
import { Providers } from '@/providers';
import { UserMenu } from './UserMenu';

let idp: IdpStub;
let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;

beforeEach(() => {
  installAuthEnv();
  resetDiscoveryCache();
  sessionStorage.clear();
  sessionStorage.setItem(AUTH.storageKeys.refresh, 'refresh-stored');
  idp = createIdpStub();
  navigate = vi.fn<(url: string) => void>();
});

afterEach(() => {
  cleanup();
});

describe.each(LOCALES)('UserMenu in %s', (locale) => {
  it('shows identity, tenant and roles, and signs out through end_session', async () => {
    render(
      <Providers locale={locale}>
        <AuthProvider locale={locale} navigate={navigate} fetchImpl={idp.fetch}>
          <UserMenu />
        </AuthProvider>
      </Providers>,
    );
    const trigger = screen.getByRole('button', { name: translate(locale, 'auth.menu') });
    await waitFor(() => {
      expect(trigger.textContent).toBe('O');
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: translate(locale, 'auth.menu') });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(within(dialog).getByText('OpenMap Admin')).toBeTruthy();
    expect(within(dialog).getByText('admin')).toBeTruthy();
    expect(within(dialog).getByText('admin@openmap.local')).toBeTruthy();
    expect(within(dialog).getByText(translate(locale, 'auth.tenant'))).toBeTruthy();
    expect(within(dialog).getByText('default').closest('.om-tag')).not.toBeNull();
    expect(within(dialog).getByText(translate(locale, 'auth.roles'))).toBeTruthy();
    for (const role of ['openmap-admin', 'offline_access']) {
      expect(within(dialog).getByText(role).closest('.om-tag')?.getAttribute('data-variant')).toBe('state');
    }

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: translate(locale, 'auth.signOut') }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(1);
    });
    const url = new URL(navigate.mock.calls[0]?.[0] ?? '');
    expect(url.origin + url.pathname).toBe(END_SESSION_URL);
    expect(url.searchParams.get('id_token_hint')).toBeTruthy();
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(window.location.origin + '/' + locale);
    expect(sessionStorage.getItem(AUTH.storageKeys.refresh)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
