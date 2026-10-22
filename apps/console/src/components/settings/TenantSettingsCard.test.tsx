// T-098 REQ-UI-019 — tenant settings editor in en and ar: values load from `tenantSettings`, an administrator's
// edits are sent as a patch of changed fields only and the saved copy replaces the form, analysts see the values
// read-only without a save button, and a refused save shows the error.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';
import { diffSettings, TenantSettingsCard } from './TenantSettingsCard';

const roles = { current: ['openmap-admin'] as string[] };
const authValue = (): AuthValue =>
  ({
    status: 'signed-in',
    user: { subject: 's1', username: 'admin', displayName: 'Admin', email: 'admin@bank.local', tenant: 'default', roles: roles.current },
    reason: undefined,
    reasonDetail: undefined,
    can: (role: string) => roles.current.includes('openmap-admin') || roles.current.includes(role),
    getAccessToken: () => 'tok',
    signIn: async () => undefined,
    completeSignIn: async () => '/',
    signOut: async () => undefined,
  }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useAuth: () => authValue(), useCan: () => authValue().can }));

const server = { settings: { locale: 'en', timeZone: 'UTC', discoveryIntervalMinutes: 60, historyRetentionDays: 365, staleAfterDays: 7, auditRetentionDays: 2555, assistantEnabled: true, outboundIntegrationsEnabled: false }, refuse: false };
const state = { calls: [] as Array<{ op: string; variables: Record<string, unknown> }> };

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  state.calls.push({ op, variables: body.variables ?? {} });
  if (op === 'TenantSettings') return { data: { tenantSettings: server.settings } };
  if (op === 'UpdateTenantSettings') {
    if (server.refuse) return { errors: [{ message: 'requires one of the roles: openmap-admin' }] };
    server.settings = { ...server.settings, ...(body.variables?.['input'] as Record<string, unknown>) };
    return { data: { updateTenantSettings: server.settings } };
  }
  return { errors: [{ message: 'unexpected operation ' + op }] };
}

beforeEach(() => {
  state.calls = [];
  roles.current = ['openmap-admin'];
  server.refuse = false;
  server.settings = { locale: 'en', timeZone: 'UTC', discoveryIntervalMinutes: 60, historyRetentionDays: 365, staleAfterDays: 7, auditRetentionDays: 2555, assistantEnabled: true, outboundIntegrationsEnabled: false };
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      return Promise.resolve(new Response(JSON.stringify(respond(JSON.parse(raw) as { query: string; variables?: Record<string, unknown> })), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(locale: (typeof LOCALES)[number]): void {
  render(
    <Providers locale={locale}>
      <TenantSettingsCard />
    </Providers>,
  );
}

describe('TenantSettingsCard', () => {
  it('diffs only the fields that changed', () => {
    const current = server.settings;
    expect(diffSettings(current, { ...current })).toEqual({});
    expect(diffSettings(current, { ...current, staleAfterDays: 14, locale: 'ar' })).toEqual({ staleAfterDays: 14, locale: 'ar' });
  });

  for (const locale of LOCALES) {
    it(`[${locale}] an administrator edits a value and saves a patch of the changed fields`, async () => {
      mount(locale);
      const stale = await screen.findByLabelText(translate(locale, 'settings.tenant.staleAfterDays'));
      expect((stale as HTMLInputElement).value).toBe('7');
      const save = screen.getByRole('button', { name: translate(locale, 'settings.tenant.save') });
      expect((save as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(stale, { target: { value: '14' } });
      expect((save as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(save);
      await screen.findByRole('status');
      const update = state.calls.find((c) => c.op === 'UpdateTenantSettings');
      expect(update?.variables).toEqual({ input: { staleAfterDays: 14 } });
      expect(server.settings.staleAfterDays).toBe(14);
      await waitFor(() => {
        expect((screen.getByLabelText(translate(locale, 'settings.tenant.staleAfterDays')) as HTMLInputElement).value).toBe('14');
      });
    });
  }

  it('analysts see the values read-only and no save button', async () => {
    roles.current = ['openmap-analyst'];
    mount('en');
    const zone = await screen.findByLabelText(translate('en', 'settings.tenant.timeZone'));
    expect((zone as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: translate('en', 'settings.tenant.save') })).toBeNull();
    expect(screen.getByText(translate('en', 'settings.tenant.readOnly'))).toBeTruthy();
  });

  it('shows the error when the API refuses the change', async () => {
    server.refuse = true;
    mount('en');
    const interval = await screen.findByLabelText(translate('en', 'settings.tenant.discoveryIntervalMinutes'));
    fireEvent.change(interval, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: translate('en', 'settings.tenant.save') }));
    expect((await screen.findByRole('alert')).textContent).toBe(translate('en', 'settings.tenant.error'));
  });
});
