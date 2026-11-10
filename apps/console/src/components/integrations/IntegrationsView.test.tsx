// T-101 REQ-UI-014 — Integrations in en and ar: the catalogue filter drives `integrations`, selecting a row loads the
// detail with mappings and deliveries, an administrator probes it (testIntegration) and creates a new one from the
// form (upsertIntegration) with blank mapping rows dropped; analysts see the list but no detail.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';
import { HEALTH_STATE, IntegrationsView, toIntegrationInput } from './IntegrationsView';

const roles = { current: ['openmap-admin'] as string[] };
const authValue = (): AuthValue =>
  ({
    status: 'signed-in',
    user: {
      subject: 's1',
      username: 'admin',
      displayName: 'Admin',
      email: 'admin@bank.local',
      tenant: 'default',
      roles: roles.current,
    },
    reason: undefined,
    reasonDetail: undefined,
    can: (role: string) => roles.current.includes('openmap-admin') || roles.current.includes(role),
    getAccessToken: () => 'tok',
    signIn: () => Promise.resolve(undefined),
    completeSignIn: () => Promise.resolve('/'),
    signOut: () => Promise.resolve(undefined),
  }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useAuth: () => authValue(),
  useCan: () => authValue().can,
}));

const base = {
  id: 'i1',
  category: 'itsm',
  vendor: 'servicenow',
  name: 'ServiceNow prod',
  enabled: true,
  direction: 'bidirectional',
  health: 'healthy',
  lastSuccessAt: '2026-10-22T10:00:00.000Z',
  lastError: null,
  deliveredLastHour: 12,
  failedLastHour: 1,
};
const detail = {
  ...base,
  endpoint: 'https://sn.example.com',
  credentialRef: 'secret/openmap/servicenow',
  settings: {},
  fieldMappings: [{ from: 'displayName', to: 'name', direction: 'out' }],
  classMappings: [{ ciType: 'host', remoteClass: 'cmdb_ci_server' }],
  subscribedEvents: ['openmap.incident.opened'],
  createdAt: '2026-10-22T09:00:00.000Z',
  updatedAt: '2026-10-22T09:00:00.000Z',
};
const deliveries = [
  {
    id: 'd1',
    direction: 'outbound',
    eventId: null,
    remoteId: 'INC0001',
    state: 'delivered',
    attempts: 1,
    responseCode: 201,
    error: null,
    createdAt: '2026-10-22T10:00:00.000Z',
    completedAt: '2026-10-22T10:00:01.000Z',
  },
];
const state = { calls: [] as Array<{ op: string; variables: Record<string, unknown> }>, slack: false };
const slack = {
  ...base,
  id: 's1',
  category: 'notification',
  vendor: 'slack',
  name: 'Ops Slack',
  direction: 'outbound',
};
const slackDetail = {
  ...slack,
  endpoint: 'https://hooks.slack.test',
  credentialRef: 'openmap/notify/slack',
  settings: { minSeverity: 'warning' },
  fieldMappings: [],
  classMappings: [],
  subscribedEvents: ['openmap.bsm.sla.breached'],
  createdAt: '2026-10-22T09:00:00.000Z',
  updatedAt: '2026-10-22T09:00:00.000Z',
};

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  state.calls.push({ op, variables: body.variables ?? {} });
  switch (op) {
    case 'Integrations': {
      const category = body.variables?.['category'];
      if (state.slack) return { data: { integrations: [slack] } };
      return {
        data: {
          integrations: category === null || category === undefined || category === 'itsm' ? [base] : [],
        },
      };
    }
    case 'Integration':
      return { data: { integration: state.slack ? slackDetail : detail } };
    case 'SendTestNotification':
      return { data: { sendTestNotification: true } };
    case 'IntegrationDeliveries':
      return { data: { integrationDeliveries: deliveries } };
    case 'TestIntegration':
      return { data: { testIntegration: { ...base, lastSuccessAt: '2026-10-22T11:00:00.000Z' } } };
    case 'UpsertIntegration':
      return {
        data: {
          upsertIntegration: {
            ...base,
            id: 'i2',
            name: (body.variables as { input: { name: string } }).input.name,
            health: 'warning',
          },
        },
      };
    default:
      return { errors: [{ message: 'unexpected operation ' + op }] };
  }
}

beforeEach(() => {
  state.calls = [];
  state.slack = false;
  roles.current = ['openmap-admin'];
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      return Promise.resolve(
        new Response(
          JSON.stringify(respond(JSON.parse(raw) as { query: string; variables?: Record<string, unknown> })),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
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
      <IntegrationsView />
    </Providers>,
  );
}

describe.each(LOCALES)('notification integrations (%s, REQ-INT-009, T-566)', (locale) => {
  it('lets an operator send a test message and says it is queued', async () => {
    state.slack = true;
    roles.current = ['openmap-operator'];
    mount(locale);
    fireEvent.click(await screen.findByRole('button', { name: 'Ops Slack' }));
    const panel = await screen.findByRole('region', { name: 'Ops Slack' });
    expect(within(panel).queryByRole('button', { name: translate(locale, 'integrations.edit') })).toBeNull();
    fireEvent.click(
      within(panel).getByRole('button', { name: translate(locale, 'integrations.notify.test') }),
    );
    await waitFor(() => {
      expect(within(panel).getByRole('status').textContent).toBe(
        translate(locale, 'integrations.notify.sent'),
      );
    });
    expect(state.calls.find((c) => c.op === 'SendTestNotification')?.variables).toEqual({ id: 's1' });
  });
});

describe('IntegrationsView helpers', () => {
  it('maps health to UI states and drops blank mapping rows', () => {
    expect(HEALTH_STATE.failing).toBe('down');
    const notify = {
      baseSettings: {},
      minSeverity: 'info' as const,
      locale: '',
      mailFrom: '',
      mailTo: '',
      startTls: true,
    };
    const input = toIntegrationInput({
      name: ' X ',
      category: 'siem',
      vendor: 'splunk',
      direction: 'outbound',
      endpoint: ' https://s ',
      credentialRef: 'ref',
      events: ['openmap.audit.action'],
      fieldMappings: [
        { from: '', to: 'b', direction: 'out' },
        { from: 'a', to: 'b', direction: 'in' },
      ],
      classMappings: [{ ciType: '', remoteClass: '' }],
      ...notify,
    });
    expect(input).toEqual({
      category: 'siem',
      vendor: 'splunk',
      name: 'X',
      endpoint: 'https://s',
      credentialRef: 'ref',
      direction: 'outbound',
      subscribedEvents: ['openmap.audit.action'],
      fieldMappings: [{ from: 'a', to: 'b', direction: 'in' }],
      classMappings: [],
    });
  });

  it('writes notification settings over the ones the form does not edit (REQ-INT-009, T-566)', () => {
    const base = {
      name: 'NOC',
      category: 'notification',
      vendor: 'email_smtp',
      direction: 'outbound',
      endpoint: 'smtp://mail.test',
      credentialRef: 'ref',
      events: [],
      fieldMappings: [],
      classMappings: [],
    };
    const input = toIntegrationInput({
      ...base,
      baseSettings: { keep: 1, locale: 'en' },
      minSeverity: 'warning',
      locale: 'ar',
      mailFrom: ' openmap@x.test ',
      mailTo: 'a@x.test, ,b@x.test',
      startTls: false,
    });
    expect(input.settings).toEqual({
      keep: 1,
      minSeverity: 'warning',
      locale: 'ar',
      from: 'openmap@x.test',
      to: ['a@x.test', 'b@x.test'],
      startTls: false,
    });
    const slack = toIntegrationInput({
      ...base,
      vendor: 'slack',
      baseSettings: { locale: 'en' },
      minSeverity: 'info',
      locale: '',
      mailFrom: '',
      mailTo: '',
      startTls: true,
    });
    expect(slack.settings).toEqual({ minSeverity: 'info' });
  });
});

describe.each(LOCALES)('IntegrationsView (%s)', (locale) => {
  it('filters by category, shows the detail with mappings and deliveries, and probes the integration', async () => {
    mount(locale);
    await screen.findByText('ServiceNow prod');
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'integrations.category.siem') }));
    await screen.findByText(translate(locale, 'integrations.list.empty'));
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'integrations.category.itsm') }));
    fireEvent.click(await screen.findByRole('button', { name: 'ServiceNow prod' }));
    const panel = await screen.findByRole('region', { name: 'ServiceNow prod' });
    expect(within(panel).getByText('displayName → name (out)')).toBeTruthy();
    expect(within(panel).getByText('host → cmdb_ci_server')).toBeTruthy();
    expect(within(panel).getByText('delivered')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: translate(locale, 'integrations.test') }));
    await waitFor(() => {
      expect(state.calls.some((c) => c.op === 'TestIntegration' && c.variables['id'] === 'i1')).toBe(true);
    });
  });

  it('creates an integration from the form', async () => {
    mount(locale);
    await screen.findByText('ServiceNow prod');
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'integrations.new') }));
    const form = await screen.findByRole('form', { name: translate(locale, 'integrations.new') });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'integrations.table.name')), {
      target: { value: 'Splunk SIEM' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'integrations.form.category')), {
      target: { value: 'siem' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'integrations.table.vendor')), {
      target: { value: 'splunk' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'integrations.form.endpoint')), {
      target: { value: 'https://splunk.example.com' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'integrations.form.credentialRef')), {
      target: { value: 'secret/openmap/splunk' },
    });
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'integrations.save') }));
    await waitFor(() => {
      const call = state.calls.find((c) => c.op === 'UpsertIntegration');
      expect(call?.variables).toEqual({
        id: null,
        input: {
          category: 'siem',
          vendor: 'splunk',
          name: 'Splunk SIEM',
          endpoint: 'https://splunk.example.com',
          credentialRef: 'secret/openmap/splunk',
          direction: 'outbound',
          subscribedEvents: [],
          fieldMappings: [],
          classMappings: [],
        },
      });
    });
  });
});

describe('IntegrationsView (analyst)', () => {
  it('lists integrations but offers no detail, probe or form', async () => {
    roles.current = ['openmap-analyst'];
    mount('en');
    await screen.findByText('ServiceNow prod');
    expect(screen.queryByRole('button', { name: translate('en', 'integrations.new') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ServiceNow prod' }));
    expect(screen.getByText(translate('en', 'integrations.detail.readOnly'))).toBeTruthy();
  });
});
