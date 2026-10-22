// T-105 REQ-UI-017 — Analytics in en and ar: the handshake (`analyticsEmbed`) feeds the embedded SDK with the
// dashboard id, the Superset origin and a token fetcher that mints a fresh tenant-scoped token; a failed handshake
// shows the unavailable state and a retry.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';
import { AnalyticsView, type EmbedFn } from './AnalyticsView';

const authValue = (): AuthValue =>
  ({ status: 'signed-in', user: { subject: 's1', username: 'an', displayName: 'Analyst', email: 'a@bank.local', tenant: 'default', roles: ['openmap-analyst'] }, reason: undefined, reasonDetail: undefined, can: () => true, getAccessToken: () => 'tok', signIn: async () => undefined, completeSignIn: async () => '/', signOut: async () => undefined }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useAuth: () => authValue(), useCan: () => authValue().can }));

const state = { fail: false, tokens: 0 };

function respond(): unknown {
  if (state.fail) return { errors: [{ message: 'Superset is not reachable' }] };
  state.tokens += 1;
  return { data: { analyticsEmbed: { supersetUrl: 'http://superset.test', dashboardId: 'dash-uuid', token: 'guest-' + String(state.tokens), expiresInSeconds: 300 } } };
}

beforeEach(() => {
  state.fail = false;
  state.tokens = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(respond()), { status: 200, headers: { 'content-type': 'application/json' } }))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('AnalyticsView (%s)', (locale) => {
  it('embeds the dashboard with the handshake and a token fetcher scoped by the API', async () => {
    const unmount = vi.fn();
    const embed = vi.fn(async (params: Parameters<EmbedFn>[0]) => {
      params.mountPoint.appendChild(document.createElement('iframe'));
      const token = await params.fetchGuestToken();
      expect(token).toBe('guest-2');
      return { unmount } as unknown as Awaited<ReturnType<EmbedFn>>;
    }) as unknown as EmbedFn;
    const view = render(
      <Providers locale={locale}>
        <AnalyticsView locale={locale} embed={embed} />
      </Providers>,
    );
    await waitFor(() => {
      expect(embed).toHaveBeenCalledTimes(1);
    });
    const params = (embed as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Parameters<EmbedFn>[0];
    expect(params.id).toBe('dash-uuid');
    expect(params.supersetDomain).toBe('http://superset.test');
    expect(params.iframeTitle).toBe(translate(locale, 'analytics.iframeTitle'));
    await screen.findByText(translate(locale, 'analytics.live'));
    expect(screen.getByRole('link', { name: translate(locale, 'analytics.openSuperset') }).getAttribute('href')).toBe('http://superset.test');
    view.unmount();
    expect(unmount).toHaveBeenCalled();
  });

  it('shows the unavailable state when the handshake fails', async () => {
    state.fail = true;
    const embed = vi.fn() as unknown as EmbedFn;
    render(
      <Providers locale={locale}>
        <AnalyticsView locale={locale} embed={embed} />
      </Providers>,
    );
    await screen.findByText(translate(locale, 'analytics.unavailable'), {}, { timeout: 8000 });
    expect(embed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: translate(locale, 'common.retry') })).toBeTruthy();
  });
});
