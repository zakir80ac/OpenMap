// T-090 REQ-SEC-005 REQ-UI-003 — Settings in en and ar: the session card shows the signed-in identity, the audit
// log lists entries newest first with action filter and paging, analysts (no auditor role) see no log at all.
// T-485 REQ-CORE-019: the API card lists the REST routes from the live OpenAPI document with the addresses.
import { CONTRACT_VERSIONS, openApiDocument, REST_ROUTES } from '@openmap/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';
import { SettingsView, summariseDetails } from './SettingsView';

const roles = { current: ['openmap-admin'] as string[] };
const authValue = (): AuthValue =>
  ({
    status: 'signed-in',
    user: { subject: 's1', username: 'auditor', displayName: 'Aisha Auditor', email: 'aisha@bank.local', tenant: 'default', roles: roles.current },
    reason: undefined,
    reasonDetail: undefined,
    can: (role: string) => roles.current.includes('openmap-admin') || roles.current.includes(role),
    getAccessToken: () => 'tok',
    signIn: () => Promise.resolve(undefined),
    completeSignIn: () => Promise.resolve('/'),
    signOut: () => Promise.resolve(undefined),
  }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useAuth: () => authValue(), useCan: () => authValue().can }));

const entries = [
  { id: 'a2', at: '2026-10-22T10:05:00.000Z', actor: 'admin', action: 'labelCi', subjectType: 'Ci', subjectId: 'ci-9', details: { arguments: { input: { ciId: 'ci-9', title: 'Core switch' } } }, traceparent: null },
  { id: 'a1', at: '2026-10-22T10:00:00.000Z', actor: 'operator', action: 'runDiscovery', subjectType: 'Sweep', subjectId: 'sw-1', details: { arguments: {} }, traceparent: '00-abc-def-01' },
];
const state = { calls: [] as Array<{ op: string; variables: Record<string, unknown> }> };

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  state.calls.push({ op, variables: body.variables ?? {} });
  if (op === 'TenantSettings') return { data: { tenantSettings: { locale: 'en', timeZone: 'UTC', discoveryIntervalMinutes: 60, historyRetentionDays: 365, staleAfterDays: 7, auditRetentionDays: 2555, assistantEnabled: true, outboundIntegrationsEnabled: false } } };
  if (op !== 'AuditLog') return { errors: [{ message: 'unexpected operation ' + op }] };
  const action = body.variables?.['action'];
  const after = body.variables?.['after'];
  const filtered = entries.filter((e) => action === null || action === undefined || e.action === action);
  if (after === 'c1') return { data: { auditLog: { edges: [], pageInfo: { endCursor: null, hasNextPage: false }, totalCount: filtered.length } } };
  return { data: { auditLog: { edges: filtered.map((node) => ({ cursor: 'c1', node })), pageInfo: { endCursor: 'c1', hasNextPage: filtered.length > 1 }, totalCount: filtered.length } } };
}

beforeEach(() => {
  state.calls = [];
  roles.current = ['openmap-admin'];
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/openapi.json')) return Promise.resolve(new Response(JSON.stringify(openApiDocument(CONTRACT_VERSIONS.rest)), { status: 200 }));
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
      <SettingsView />
    </Providers>,
  );
}

describe.each(LOCALES)('SettingsView (%s)', (locale) => {
  it('shows the session and the audit log newest first, filters by action and pages', async () => {
    mount(locale);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translate(locale, 'settings.title'));
    expect(screen.getByText('Aisha Auditor')).toBeTruthy();
    expect(screen.getByText('default')).toBeTruthy();
    // The audit log is the unnamed table; the API card's routes table carries a name.
    const auditTable = (): HTMLElement => {
      const t = screen.getAllByRole('table').find((el) => el.getAttribute('aria-label') === null);
      if (t === undefined) throw new Error('no audit table');
      return t;
    };
    const table = await waitFor(auditTable);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] ?? document.body).getByText('labelCi')).toBeTruthy();
    expect(within(rows[2] ?? document.body).getByText('operator')).toBeTruthy();
    expect(screen.getByText(translate(locale, 'settings.audit.total', { count: '2' }))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'settings.audit.more') }));
    await waitFor(() => {
      expect(state.calls.some((c) => c.variables['after'] === 'c1')).toBe(true);
    });

    fireEvent.change(screen.getByRole('combobox', { name: translate(locale, 'settings.audit.filter.action') }), { target: { value: 'runDiscovery' } });
    await waitFor(() => {
      expect(state.calls.some((c) => c.variables['action'] === 'runDiscovery')).toBe(true);
    });
    await waitFor(() => {
      expect(within(auditTable()).getAllByRole('row')).toHaveLength(2);
    });
  });

  it('T-485 lists the REST routes from the live OpenAPI document with the addresses', async () => {
    mount(locale);
    const card = screen.getByRole('region', { name: translate(locale, 'settings.api.title') });
    expect(within(card).getByText('http://api.test/api/v1')).toBeTruthy();
    expect(within(card).getByText('http://api.test/api/v1/openapi.json')).toBeTruthy();
    expect(within(card).getByText('http://api.test/graphql')).toBeTruthy();
    const routes = await within(card).findByRole('table', { name: translate(locale, 'settings.api.routes', { version: CONTRACT_VERSIONS.rest }) });
    // One row per route of the table, plus the header.
    expect(within(routes).getAllByRole('row')).toHaveLength(Object.keys(REST_ROUTES).length + 1);
    expect(within(routes).getByText(translate(locale, 'settings.api.op.getCiImpact'))).toBeTruthy();
    expect(within(routes).getAllByText(translate(locale, 'settings.api.write'))).toHaveLength(Object.values(REST_ROUTES).filter((r) => r.write).length);
  });

  it('hides the audit log from roles below auditor', () => {
    roles.current = ['openmap-analyst'];
    mount(locale);
    expect(screen.queryByText(translate(locale, 'settings.audit.title'))).toBeNull();
    expect(state.calls.filter((c) => c.op === 'AuditLog')).toHaveLength(0);
  });
});

describe('summariseDetails', () => {
  it('flattens the mutation arguments into one line', () => {
    expect(summariseDetails({ arguments: { ciId: 'x', attributes: { a: 1 } } })).toBe('ciId=x · attributes={"a":1}');
  });
});
