// T-066 T-136 REQ-UI-012 REQ-BSM-002 REQ-BSM-006 REQ-BSM-008 — ServicesView groups services by state, filters, links root T-475 REQ-BSM-005
// causes, shows the current window and the uptime table with its granularity and export, lets an operator assign and
// create SLAs, and runs incidents through acknowledge, assign, resolve and RCA over stubbed GraphQL, in en and ar.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useCan: () => () => true,
}));

import { Providers } from '@/providers';
import {
  SERVICE_GROUP_ORDER,
  ServicesView,
  errorBudgetPercent,
  groupServices,
  windowLabelKey,
} from './ServicesView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/services',
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const ci = (id: string, displayName: string) => ({
  id,
  name: id,
  displayName,
  code: id.toUpperCase(),
  type: 'business_service',
  layer: 'applications',
  health: 'healthy',
});
const period = (
  year: number,
  month: number,
  percent: number | null,
  target: number | null,
  current = false,
) => ({
  granularity: 'month',
  year,
  month,
  quarter: null,
  periodStart: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
  periodEnd: new Date(Date.UTC(year, month, 1)).toISOString(),
  current,
  availabilityPercent: percent,
  elapsedMinutes: 43200,
  downtimeMinutes: percent === null ? 0 : Math.round(((100 - percent) / 100) * 43200),
  degradedMinutes: 0,
  unknownMinutes: 0,
  targetPercent: target,
  met: percent === null || target === null ? null : percent >= target,
  budgetMinutes: target === null ? null : ((100 - target) / 100) * 43200,
  budgetRemainingMinutes: target === null ? null : 4.8,
  burnRate: target === null ? null : 1.5,
});
const gold = {
  id: 'sla-gold',
  name: 'Gold',
  description: 'Tier-1 commitments',
  availabilityTargetPercent: 99.95,
  window: 'calendar_month',
  responseTargets: [
    { severity: 'critical', respondMinutes: 15, resolveMinutes: 240 },
    { severity: 'high', respondMinutes: 30, resolveMinutes: 480 },
    { severity: 'medium', respondMinutes: 60, resolveMinutes: 1440 },
  ],
  burnRateAlert: 2,
  services: [{ id: 'svc-bank', displayName: 'Online banking' }],
};

const services = [
  {
    service: ci('svc-bank', 'Online banking'),
    state: 'down',
    since: '2026-10-22T09:27:15.000Z',
    rootCauses: [ci('pdu-b', 'PDU-R12-B')],
    slaTarget: 99.95,
    errorBudgetRemainingMinutes: 4.8,
    sla: { id: 'sla-gold', name: 'Gold', window: 'calendar_month' },
    currentWindow: period(2026, 11, 99.2, 99.95, true),
  },
  {
    service: ci('svc-pay', 'Payments gateway'),
    state: 'degraded',
    since: '2026-10-22T09:28:00.000Z',
    rootCauses: [],
    slaTarget: 99.9,
    errorBudgetRemainingMinutes: 120,
    sla: null,
    currentWindow: period(2026, 11, 99.97, 99.9, true),
  },
  {
    service: ci('svc-hr', 'HR portal'),
    state: 'healthy',
    since: '2026-09-01T00:00:00.000Z',
    rootCauses: [],
    slaTarget: 99.5,
    errorBudgetRemainingMinutes: 3000,
    sla: null,
    currentWindow: period(2026, 11, 100, 99.5, true),
  },
  {
    service: ci('svc-crm', 'CRM'),
    state: 'healthy',
    since: '2026-09-01T00:00:00.000Z',
    rootCauses: [],
    slaTarget: 99.5,
    errorBudgetRemainingMinutes: -12,
    sla: null,
    currentWindow: period(2026, 11, null, 99.5, true),
  },
];

const incident = {
  id: 'inc-1',
  title: 'Online banking down',
  description: 'Ledger DB lost power',
  severity: 'critical',
  state: 'open',
  source: 'bsm',
  service: ci('svc-bank', 'Online banking'),
  sla: { id: 'sla-gold', name: 'Gold' },
  openedAt: '2026-10-22T09:27:15.000Z',
  acknowledgedAt: null,
  resolvedAt: null,
  closedAt: null,
  assignee: null,
  respondBy: '2026-10-22T09:42:15.000Z',
  resolveBy: '2026-10-22T13:27:15.000Z',
  responseBreachedAt: null,
  resolutionBreachedAt: null,
  resolutionNote: null,
  rootCause: ci('pdu-b', 'PDU-R12-B'),
  alerts: 11,
  links: [
    {
      integration: { id: 'int-1', vendor: 'servicenow', name: 'ServiceNow prod' },
      remoteId: 'INC0412',
      remoteUrl: null,
      remoteState: 'open',
      syncedAt: '2026-10-22T09:30:00.000Z',
    },
  ],
  rca: null,
  runbook: null,
  suggestedRunbook: null,
  runbookRuns: [],
  recoveryEstimateMinutes: null,
  recoveryRemainingMinutes: null,
  timeline: [
    {
      at: '2026-10-22T09:27:15.000Z',
      actor: '/openmap/bsm-engine',
      kind: 'openmap.incident.opened',
      details: {},
    },
  ],
};

const report = (granularity: string) =>
  services.slice(0, 2).map((s) => ({
    service: { ...s.service },
    sla: s.sla === null ? null : { id: s.sla.id, name: s.sla.name },
    periods: [
      { ...period(2026, 10, s.service.id === 'svc-bank' ? 99.8 : 100, s.slaTarget), granularity },
      { ...period(2026, 11, s.currentWindow.availabilityPercent, s.slaTarget, true), granularity },
    ],
  }));

const calls: Array<{ op: string; variables: Record<string, unknown> }> = [];

// REQ-BSM-005 (T-475): the runbook the incident is offered, attached and run.
const runbookFull = {
  id: 'rb-1',
  code: 'RB-DB-01',
  title: 'Database failover',
  ownerTeam: 'DBA',
  lastReviewedAt: null,
  estimatedMinutes: 15,
  updatedAt: '2026-11-08T00:00:00.000Z',
  steps: [
    { order: 1, instruction: 'Fail over the database', estimatedMinutes: 10, automation: { action: '42', integration: { id: 'int-awx', name: 'AWX', vendor: 'ansible_awx' } } },
    { order: 2, instruction: 'Confirm reconnection', estimatedMinutes: 5, automation: null },
  ],
};
const runbookState = { attached: false, runs: [] as Array<Record<string, unknown>> };

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  const v = body.variables ?? {};
  calls.push({ op, variables: v });
  switch (op) {
    case 'Services':
      return { data: { services } };
    case 'Incidents':
      return {
        data: {
          incidents: [
            {
              ...incident,
              runbook: runbookState.attached ? runbookFull : null,
              suggestedRunbook: runbookState.attached ? null : { id: 'rb-1', code: 'RB-DB-01', title: 'Database failover', estimatedMinutes: 15 },
              runbookRuns: runbookState.runs,
              recoveryEstimateMinutes: runbookState.attached ? 15 : null,
              recoveryRemainingMinutes: runbookState.attached ? 15 - runbookState.runs.length * 10 : null,
            },
          ],
        },
      };
    case 'Runbooks':
      return { data: { runbooks: [runbookFull] } };
    case 'SetIncidentRunbook':
      runbookState.attached = v['runbookId'] !== null;
      return { data: { setIncidentRunbook: { id: incident.id } } };
    case 'RunRunbookStep': {
      const run = { id: 'run-' + String(runbookState.runs.length), order: v['order'], outcome: 'triggered', actor: 'syed', note: null, remoteId: '9001', error: null, at: '2026-11-08T00:05:00.000Z', integration: { id: 'int-awx', name: 'AWX' } };
      runbookState.runs.push(run);
      return { data: { runRunbookStep: run } };
    }
    case 'Slas':
      return { data: { slas: [gold] } };
    case 'AvailabilityReport':
      return { data: { availabilityReport: report(String(v['granularity'])) } };
    case 'AvailabilityReportCsv':
      return { data: { availabilityReportCsv: 'service,code\n' } };
    case 'AcknowledgeIncident':
      return {
        data: {
          acknowledgeIncident: {
            ...incident,
            state: 'acknowledged',
            acknowledgedAt: '2026-10-22T09:30:00.000Z',
          },
        },
      };
    case 'AssignIncident':
      return {
        data: { assignIncident: { ...incident, state: 'acknowledged', assignee: String(v['assignee']) } },
      };
    case 'ResolveIncident':
      return {
        data: {
          resolveIncident: {
            ...incident,
            state: 'resolved',
            resolvedAt: '2026-10-22T10:00:00.000Z',
            resolutionNote: String(v['note']),
          },
        },
      };
    case 'CloseIncident':
      return {
        data: { closeIncident: { ...incident, state: 'closed', closedAt: '2026-10-22T11:00:00.000Z' } },
      };
    case 'UpdateIncidentRca': {
      const input = v['input'] as { summary: string };
      return {
        data: {
          updateIncidentRca: {
            ...incident,
            rca: {
              summary: input.summary,
              rootCauseCi: incident.rootCause,
              contributingFactors: [],
              correctiveActions: [],
              owner: null,
              dueAt: null,
              completedAt: null,
              updatedBy: 'tester',
              updatedAt: '2026-10-22T12:00:00.000Z',
            },
          },
        },
      };
    }
    case 'UpsertSla': {
      const input = v['input'] as { name: string; availabilityTargetPercent: number; window: string };
      return {
        data: {
          upsertSla: {
            ...gold,
            id: 'sla-new',
            name: input.name,
            availabilityTargetPercent: input.availabilityTargetPercent,
            window: input.window,
            services: [],
          },
        },
      };
    }
    case 'DeleteSla':
      return { data: { deleteSla: true } };
    case 'AssignSla':
      return { data: { assignSla: { ...services[0], sla: v['slaId'] === null ? null : services[0]?.sla } } };
    default:
      return { errors: [{ message: 'unexpected operation ' + op }] };
  }
}

beforeEach(() => {
  calls.length = 0;
  runbookState.attached = false;
  runbookState.runs = [];
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
      <ServicesView locale={locale} />
    </Providers>,
  );
}

describe('groupServices', () => {
  it('orders groups worst first and sorts within a group by remaining error budget', () => {
    expect(SERVICE_GROUP_ORDER).toEqual(['down', 'degraded', 'unknown', 'healthy']);
    const groups = groupServices(services as never, undefined);
    expect(groups.map((g) => g.state)).toEqual(['down', 'degraded', 'healthy']);
    expect(groups[2]?.items.map((s) => s.service.id)).toEqual(['svc-crm', 'svc-hr']);
    expect(groupServices(services as never, 'degraded').map((g) => g.state)).toEqual(['degraded']);
  });
  it('turns remaining minutes into a share of the period budget', () => {
    // 99.95% over 30 days allows 21.6 minutes of downtime.
    expect(errorBudgetPercent(99.95, 21.6)).toBeCloseTo(100);
    expect(errorBudgetPercent(99.95, 10.8)).toBeCloseTo(50);
    expect(errorBudgetPercent(99.95, -5)).toBe(0);
    expect(errorBudgetPercent(100, 10)).toBe(0);
    expect(errorBudgetPercent(99.9, 10000)).toBe(100);
  });
  it('labels the measuring window from the SLA, falling back to the rolling 30 days', () => {
    expect(windowLabelKey('calendar_quarter')).toBe('services.window.calendar_quarter');
    expect(windowLabelKey(null)).toBe('services.window.rolling_30d');
  });
});

describe.each(LOCALES)('ServicesView in %s', (locale) => {
  const percent = (value: number): string =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);

  it('renders grouped services with root causes, SLA target, budget, the current window and the incidents panel', async () => {
    mount(locale);
    expect((await screen.findAllByRole('link', { name: 'Online banking' })).length).toBeGreaterThan(0);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toContain(translate(locale, 'services.group.down'));
    expect(screen.getByRole('link', { name: 'PDU-R12-B' }).getAttribute('href')).toBe(
      '/' + locale + '/cmdb/pdu-b',
    );
    expect(screen.getAllByRole('link', { name: 'Online banking' })[0]?.getAttribute('href')).toBe(
      '/' + locale + '/services/svc-bank',
    );
    expect(
      screen.getByText(
        translate(locale, 'services.slaTarget', { target: new Intl.NumberFormat(locale).format(99.95) }),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        translate(locale, 'services.errorBudgetExhausted', {
          minutes: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(12),
        }),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        translate(locale, 'services.window.availability', {
          percent: percent(99.2),
          window: translate(locale, 'services.window.calendar_month'),
        }),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        translate(locale, 'services.window.availability', {
          percent: percent(99.97),
          window: translate(locale, 'services.window.rolling_30d'),
        }),
      ),
    ).toBeTruthy();
    const aside = screen.getByRole('complementary');
    expect(
      within(aside).getByText(
        translate(locale, 'services.incidents.alerts', { count: new Intl.NumberFormat(locale).format(11) }),
      ),
    ).toBeTruthy();
    expect(within(aside).getByText('servicenow · INC0412 · open')).toBeTruthy();
    expect(within(aside).getByText(translate(locale, 'services.sla.severity.critical'))).toBeTruthy();
    expect(within(aside).getByText(translate(locale, 'services.incidents.unassigned'))).toBeTruthy();
    expect(
      screen
        .getAllByRole('link', { name: new RegExp(translate(locale, 'services.showInMap')) })[0]
        ?.getAttribute('href'),
    ).toBe('/' + locale + '/dependencies?ci=svc-bank&direction=downstream');
  });

  it('filters by state through the chips', async () => {
    mount(locale);
    await screen.findAllByRole('link', { name: 'Online banking' });
    const filter = screen.getByRole('group', { name: translate(locale, 'services.filter') });
    fireEvent.click(within(filter).getByRole('button', { name: translate(locale, 'health.healthy') }));
    expect(
      screen.queryByRole('heading', { level: 2, name: new RegExp(translate(locale, 'services.group.down')) }),
    ).toBeNull();
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: new RegExp(translate(locale, 'services.group.healthy')),
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'HR portal' })).toBeTruthy();
    // The incident panel still lists the down service; only the service list is filtered.
    expect(
      within(screen.getByRole('complementary')).getByRole('link', { name: 'Online banking down' }),
    ).toBeTruthy();
  });

  it('shows the uptime table per period, switches granularity and exports the CSV', async () => {
    mount(locale);
    const table = await screen.findByTestId('uptime-table');
    expect(table.getAttribute('data-granularity')).toBe('month');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText(percent(99.8) + '%')).toBeTruthy();
    expect(within(table).getAllByText(translate(locale, 'services.uptime.missed')).length).toBeGreaterThan(0);
    expect(within(table).getByText(translate(locale, 'services.uptime.current'))).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: translate(locale, 'services.uptime.quarter') }));
    await waitFor(() => {
      expect(
        calls.some((c) => c.op === 'AvailabilityReport' && c.variables['granularity'] === 'quarter'),
      ).toBe(true);
    });
    // The export waits for the re-fetched report: the button is disabled while the quarter table loads.
    await waitFor(() => {
      expect(screen.getByTestId('uptime-table').getAttribute('data-granularity')).toBe('quarter');
    });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'services.uptime.export') }));
    await waitFor(() => {
      expect(calls.some((c) => c.op === 'AvailabilityReportCsv')).toBe(true);
    });
  });

  it('assigns and clears an SLA for a service through the select', async () => {
    mount(locale);
    await screen.findAllByRole('link', { name: 'Online banking' });
    const selects = await screen.findAllByLabelText<HTMLSelectElement>(
      translate(locale, 'services.sla.assign'),
    );
    const bank = selects.find(
      (s) => s.closest('[data-service-id]')?.getAttribute('data-service-id') === 'svc-bank',
    );
    expect(bank?.value).toBe('sla-gold');
    fireEvent.change(bank as HTMLSelectElement, { target: { value: '' } });
    await waitFor(() => {
      expect(calls.find((c) => c.op === 'AssignSla')?.variables).toEqual({
        serviceId: 'svc-bank',
        slaId: null,
      });
    });
  });

  it('lists the SLA catalogue and creates an SLA from the form', async () => {
    mount(locale);
    const list = await screen.findByTestId('sla-list');
    expect(within(list).getByText('Gold')).toBeTruthy();
    expect(
      within(list).getByText(
        translate(locale, 'services.sla.servicesCount', {
          count: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(1),
        }),
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'services.sla.new') }));
    const form = screen.getByRole('form', { name: translate(locale, 'services.sla.create') });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'services.sla.name')), {
      target: { value: 'Silver' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'services.sla.target')), {
      target: { value: '99.5' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'services.sla.window')), {
      target: { value: 'calendar_quarter' },
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(calls.find((c) => c.op === 'UpsertSla')?.variables).toMatchObject({
        id: null,
        input: { name: 'Silver', availabilityTargetPercent: 99.5, window: 'calendar_quarter' },
      });
    });
    expect(await screen.findByText(translate(locale, 'services.sla.saved'))).toBeTruthy();
  });

  it('T-475 attaches the suggested runbook to an incident and triggers its automated step', async () => {
    mount(locale);
    const aside = screen.getByRole('complementary');
    fireEvent.click(await within(aside).findByRole('button', { name: translate(locale, 'services.runbook.title') }));
    const section = within(aside).getByRole('region', { name: translate(locale, 'services.runbook.title') });
    expect(within(section).getByText(translate(locale, 'services.runbook.suggested', { code: 'RB-DB-01', title: 'Database failover' }))).toBeTruthy();
    const pick = await within(section).findByLabelText(translate(locale, 'services.runbook.pick'));
    expect((pick as HTMLSelectElement).value).toBe('rb-1');
    fireEvent.click(within(section).getByRole('button', { name: translate(locale, 'services.runbook.attach') }));
    await waitFor(() => {
      expect(calls.find((c) => c.op === 'SetIncidentRunbook')?.variables).toEqual({ incidentId: incident.id, runbookId: 'rb-1' });
    });
    const steps = await within(aside).findByRole('list', { name: translate(locale, 'services.runbook.steps') });
    expect(within(steps).getByText('Fail over the database')).toBeTruthy();
    fireEvent.click(within(steps).getByRole('button', { name: translate(locale, 'services.runbook.trigger') }));
    await waitFor(() => {
      expect(calls.find((c) => c.op === 'RunRunbookStep')?.variables).toEqual({ incidentId: incident.id, order: 1 });
    });
    await waitFor(() => {
      expect(within(steps).getByText(translate(locale, 'services.runbook.outcome.triggered'))).toBeTruthy();
    });
    expect(within(steps).getByRole('button', { name: translate(locale, 'services.runbook.markDone') })).toBeTruthy();
  });

  it('acknowledges, assigns, records the RCA and resolves an incident through the mutations', async () => {
    mount(locale);
    const aside = screen.getByRole('complementary');
    fireEvent.click(
      await within(aside).findByRole('button', { name: translate(locale, 'services.incidents.acknowledge') }),
    );
    await waitFor(() => {
      expect(calls.some((c) => c.op === 'AcknowledgeIncident')).toBe(true);
    });
    fireEvent.change(within(aside).getByLabelText(translate(locale, 'services.incidents.assignTo')), {
      target: { value: 'ops.lead' },
    });
    fireEvent.click(
      within(aside).getByRole('button', { name: translate(locale, 'services.incidents.assign') }),
    );
    await waitFor(() => {
      expect(calls.find((c) => c.op === 'AssignIncident')?.variables).toEqual({
        incidentId: 'inc-1',
        assignee: 'ops.lead',
      });
    });
    fireEvent.click(within(aside).getByRole('button', { name: translate(locale, 'services.rca.open') }));
    const rca = within(aside).getByRole('region', { name: translate(locale, 'services.rca.title') });
    expect(within(rca).getByLabelText(translate(locale, 'services.rca.rootCause'))).toHaveProperty(
      'value',
      'pdu-b',
    );
    fireEvent.change(within(rca).getByLabelText(translate(locale, 'services.rca.summary')), {
      target: { value: 'Breaker tripped' },
    });
    fireEvent.click(within(rca).getByRole('button', { name: translate(locale, 'services.rca.addAction') }));
    fireEvent.change(within(rca).getByLabelText(translate(locale, 'services.rca.action.description')), {
      target: { value: 'Add B feed' },
    });
    fireEvent.click(within(rca).getByRole('button', { name: translate(locale, 'services.rca.save') }));
    await waitFor(() => {
      expect(calls.find((c) => c.op === 'UpdateIncidentRca')?.variables).toMatchObject({
        incidentId: 'inc-1',
        input: {
          summary: 'Breaker tripped',
          rootCauseCiId: 'pdu-b',
          correctiveActions: [{ description: 'Add B feed', owner: null, dueAt: null, done: false }],
        },
      });
    });
    fireEvent.change(within(aside).getByLabelText(translate(locale, 'services.incidents.resolveNote')), {
      target: { value: 'Feed restored' },
    });
    fireEvent.click(
      within(aside).getByRole('button', { name: translate(locale, 'services.incidents.resolve') }),
    );
    await waitFor(() => {
      expect(calls.find((c) => c.op === 'ResolveIncident')?.variables).toEqual({
        incidentId: 'inc-1',
        note: 'Feed restored',
      });
    });
    fireEvent.click(
      within(aside).getByRole('button', { name: translate(locale, 'services.timeline.title') }),
    );
    expect(within(aside).getByText('openmap.incident.opened')).toBeTruthy();
  });
});
