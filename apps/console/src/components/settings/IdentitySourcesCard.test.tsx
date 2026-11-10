// T-646 REQ-INT-016 (ADR-074) — the Identity sources card over stubbed GraphQL, in en and ar: an applied Active
// Directory with its group mapping, a passed bind test and its last sync; an Entra ID source whose apply failed, with
// the reason and the redirect URI to register; adding an Okta source sends OpenID Connect settings only (domain,
// authorization server, client, secret ref, mappings), and the draft is checked against the contract before it is sent.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { IdentitySourceView } from '@/lib/identity-source-queries';
import { EMPTY_DRAFT, IdentitySourcesCard, inputOf } from './IdentitySourcesCard';

const ad: IdentitySourceView = {
  id: '3f2b9c1e-0000-4000-8000-000000000001',
  kind: 'ldap',
  vendor: 'active_directory',
  name: 'Corp AD',
  alias: 'openmap-corp-ad-3f2b9c1e',
  enabled: true,
  secretRef: 'identity/corp-ad',
  ldap: { connectionUrl: 'ldaps://dc01.corp.example:636', startTls: false, bindDn: 'CN=svc,DC=corp,DC=example', usersDn: 'OU=People,DC=corp,DC=example', userFilter: null, groupsDn: 'OU=Groups,DC=corp,DC=example', usernameAttribute: 'sAMAccountName', syncPeriodMinutes: 60 },
  oidc: null,
  roleMappings: [{ group: 'OpenMap Operators', role: 'operator' }],
  state: 'applied',
  lastError: null,
  lastTest: { ok: true, message: 'Keycloak connected to ldaps://dc01.corp.example:636 and bound as CN=svc,DC=corp,DC=example', at: '2026-11-10T08:00:00.000Z' },
  lastSync: { added: 120, updated: 3, removed: 0, failed: 0, groups: 14, message: '120 imported users', at: '2026-11-10T08:05:00.000Z' },
};
const entra: IdentitySourceView = {
  id: '1a2b3c4d-0000-4000-8000-000000000002',
  kind: 'oidc',
  vendor: 'entra_id',
  name: 'Corp Entra ID',
  alias: 'openmap-corp-entra-id-1a2b3c4d',
  enabled: true,
  secretRef: 'identity/entra',
  ldap: null,
  oidc: { issuer: 'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0', directoryTenantId: 'contoso.onmicrosoft.com', domain: null, authorizationServerId: null, clientId: 'b1e0c2a4', scopes: 'openid profile email', groupsClaim: 'groups', redirectUri: 'https://sso.corp.example/realms/openmap/broker/openmap-corp-entra-id-1a2b3c4d/endpoint' },
  roleMappings: [],
  state: 'error',
  lastError: 'Keycloak could not read the discovery document',
  lastTest: null,
  lastSync: null,
};

let sent: Array<{ query: string; variables: Record<string, unknown> }> = [];

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { query: string; variables: Record<string, unknown> };
      sent.push(body);
      const data = body.query.includes('upsertIdentitySource') ? { upsertIdentitySource: { ...entra, id: 'new' } } : { identitySources: [ad, entra] };
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('IdentitySourcesCard (%s)', (locale) => {
  const t = (key: string, params?: Record<string, string | number>) => translate(locale, key as Parameters<typeof translate>[1], params);
  const show = () =>
    render(
      <Providers locale={locale}>
        <IdentitySourcesCard />
      </Providers>,
    );

  it('shows each source with its state, mappings, last test and sync, and a provider’s redirect URI', async () => {
    show();
    const table = await screen.findByRole('table', { name: t('identitySources.title') });
    const rows = within(table).getAllByTestId('identity-source-row');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['applied', 'error']);
    const [adRow, entraRow] = rows as [HTMLElement, HTMLElement];
    expect(within(adRow).getByText(t('identitySources.vendor.active_directory'))).toBeTruthy();
    expect(within(adRow).getByText(t('identitySources.state.applied'))).toBeTruthy();
    expect(within(adRow).getByText(t('identitySources.mapping', { group: 'OpenMap Operators', role: t('identitySources.role.operator') }))).toBeTruthy();
    expect(within(adRow).getByTestId('identity-test-result').getAttribute('data-ok')).toBe('true');
    expect(within(adRow).getByTestId('identity-sync-result').textContent).toContain(new Intl.NumberFormat(locale).format(120));
    expect(within(adRow).getByRole('button', { name: t('identitySources.sync', { name: 'Corp AD' }) })).toBeTruthy();
    expect(within(entraRow).getByText(t('identitySources.state.error'))).toBeTruthy();
    expect(within(entraRow).getByText('Keycloak could not read the discovery document')).toBeTruthy();
    expect(within(entraRow).getByTestId('identity-redirect-uri').textContent).toBe(entra.oidc?.redirectUri);
    expect(within(entraRow).queryByRole('button', { name: t('identitySources.sync', { name: 'Corp Entra ID' }) })).toBeNull();
    expect(within(entraRow).getByText(t('identitySources.notTested'))).toBeTruthy();
  });

  it('adds an Okta source with OpenID Connect settings only', async () => {
    show();
    await screen.findByRole('table', { name: t('identitySources.title') });
    fireEvent.click(screen.getByRole('button', { name: t('identitySources.add') }));
    const form = screen.getByRole('form', { name: t('identitySources.form') });
    const set = (label: string, value: string): void => {
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    };
    set(t('identitySources.field.vendor'), 'okta');
    set(t('identitySources.field.name'), 'Okta');
    set(t('identitySources.field.secretRef'), 'identity/okta');
    set(t('identitySources.field.domain'), 'acme.okta.com');
    set(t('identitySources.field.authorizationServerId'), 'default');
    set(t('identitySources.field.clientId'), '0oa1okta');
    set(t('identitySources.field.group'), 'OpenMap Admins');
    set(t('identitySources.field.role'), 'admin');
    expect(within(form).queryByLabelText(t('identitySources.field.bindDn'))).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: t('identitySources.save') }));
    await waitFor(() => {
      expect(sent.some((s) => s.query.includes('upsertIdentitySource'))).toBe(true);
    });
    const upsert = sent.find((s) => s.query.includes('upsertIdentitySource'));
    expect(upsert?.variables).toEqual({
      id: null,
      input: {
        vendor: 'okta',
        name: 'Okta',
        enabled: true,
        secretRef: 'identity/okta',
        roleMappings: [{ group: 'OpenMap Admins', role: 'admin' }],
        oidc: { issuer: null, directoryTenantId: null, domain: 'acme.okta.com', authorizationServerId: 'default', clientId: '0oa1okta', scopes: null, groupsClaim: null },
      },
    });
  });
});

describe('identity source draft', () => {
  it('checks the draft against the contract before sending it', () => {
    const directory = { ...EMPTY_DRAFT, name: 'Lab', secretRef: 'identity/lab', connectionUrl: 'ldap://ldap.lab:389', bindDn: 'cn=admin,dc=lab', usersDn: 'ou=users,dc=lab', groupsDn: 'ou=groups,dc=lab', vendor: 'ldap' as const };
    const ok = inputOf({ ...directory, roleMappings: [{ group: 'ops', role: 'operator' }, { group: ' ', role: 'admin' }], syncPeriodMinutes: '30' });
    expect('input' in ok && ok.input.ldap).toMatchObject({ syncPeriodMinutes: 30, userFilter: null, usernameAttribute: null });
    expect('input' in ok && ok.input.roleMappings).toEqual([{ group: 'ops', role: 'operator' }]);
    expect(inputOf({ ...directory, syncPeriodMinutes: '1' })).toEqual({ error: 'ldap.syncPeriodMinutes' });
    expect(inputOf({ ...EMPTY_DRAFT, vendor: 'entra_id', name: 'Entra', secretRef: 'identity/entra', clientId: 'app' })).toEqual({ error: 'oidc.directoryTenantId' });
  });
});
