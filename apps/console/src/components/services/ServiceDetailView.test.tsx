// T-137 REQ-UI-012 REQ-BSM-006 REQ-BSM-008 — ServiceDetailView shows one service's SLA, current window, uptime per
// period with incidents and its incident list, and the not-found state, in en and ar over stubbed GraphQL.
import { cleanup, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useCan: () => () => true,
}));

import { Providers } from '@/providers';
import { ServiceDetailView } from './ServiceDetailView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/services/svc-bank',
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
  health: 'down',
});
const period = (year: number, month: number, percent: number, current: boolean) => ({
  granularity: 'month',
  year,
  month,
  quarter: null,
  periodStart: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
  periodEnd: new Date(Date.UTC(year, month, 1)).toISOString(),
  current,
  availabilityPercent: percent,
  elapsedMinutes: 43200,
  downtimeMinutes: 60,
  degradedMinutes: 0,
  unknownMinutes: 0,
  targetPercent: 99.95,
  met: percent >= 99.95,
  budgetMinutes: 21.6,
  budgetRemainingMinutes: 4.8,
  burnRate: 1.5,
  incidents: [
    {
      id: 'inc-1',
      title: 'Online banking down',
      severity: 'critical',
      state: 'resolved',
      openedAt: '2026-10-22T09:27:15.000Z',
      resolvedAt: '2026-10-22T10:27:15.000Z',
    },
  ],
});
const service = {
  service: ci('svc-bank', 'Online banking'),
  state: 'down',
  since: '2026-10-22T09:27:15.000Z',
  rootCauses: [ci('pdu-b', 'PDU-R12-B')],
  slaTarget: 99.95,
  errorBudgetRemainingMinutes: 4.8,
  sla: { id: 'sla-gold', name: 'Gold', window: 'calendar_month' },
  currentWindow: period(2026, 11, 99.2, true),
};
const incident = {
  id: 'inc-1',
  title: 'Online banking down',
  description: 'Ledger DB lost power',
  severity: 'critical',
  state: 'resolved',
  source: 'bsm',
  service: ci('svc-bank', 'Online banking'),
  sla: { id: 'sla-gold', name: 'Gold' },
  openedAt: '2026-10-22T09:27:15.000Z',
  acknowledgedAt: '2026-10-22T09:30:00.000Z',
  resolvedAt: '2026-10-22T10:27:15.000Z',
  closedAt: null,
  assignee: 'ops.lead',
  respondBy: '2026-10-22T09:42:15.000Z',
  resolveBy: '2026-10-22T13:27:15.000Z',
  responseBreachedAt: null,
  resolutionBreachedAt: null,
  resolutionNote: 'Feed restored',
  rootCause: ci('pdu-b', 'PDU-R12-B'),
  alerts: 3,
  links: [],
  rca: null,
  timeline: [],
};
const state = { missing: false };

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  switch (op) {
    case 'Service':
      return { data: { service: state.missing ? null : service } };
    case 'ServiceAvailability':
      return {
        data: { service: { availability: [period(2026, 10, 99.8, false), period(2026, 11, 99.2, true)] } },
      };
    case 'Incidents':
      return { data: { incidents: [incident] } };
    default:
      return { errors: [{ message: 'unexpected operation ' + op }] };
  }
}

beforeEach(() => {
  state.missing = false;
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

describe.each(LOCALES)('ServiceDetailView in %s', (locale) => {
  it('shows the SLA, the current window, the uptime periods and the incidents of the service', async () => {
    render(
      <Providers locale={locale}>
        <ServiceDetailView locale={locale} id="svc-bank" />
      </Providers>,
    );
    const detail = await screen.findByTestId('service-detail');
    expect(within(detail).getByRole('heading', { level: 1 }).textContent).toContain('Online banking');
    expect(within(detail).getAllByText('Gold').length).toBeGreaterThan(0);
    const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
    expect(within(detail).getAllByText(percent.format(99.2) + '%').length).toBeGreaterThan(0);
    const table = await within(detail).findByTestId('uptime-table');
    expect(within(table).getByText(percent.format(99.8) + '%')).toBeTruthy();
    expect(within(detail).getByRole('link', { name: 'PDU-R12-B' }).getAttribute('href')).toBe(
      '/' + locale + '/cmdb/pdu-b',
    );
    expect(
      within(detail).getByRole('heading', { level: 2, name: translate(locale, 'services.detail.incidents') }),
    ).toBeTruthy();
    expect(within(detail).getByRole('link', { name: 'Online banking down' })).toBeTruthy();
    expect(within(detail).getByText(translate(locale, 'services.incidents.state.resolved'))).toBeTruthy();
    expect(
      within(detail).getByText(translate(locale, 'services.incidents.assignee', { name: 'ops.lead' })),
    ).toBeTruthy();
    expect(
      within(detail).getByRole('button', { name: translate(locale, 'services.incidents.close') }),
    ).toBeTruthy();
  });

  it('says so when the service does not exist', async () => {
    state.missing = true;
    render(
      <Providers locale={locale}>
        <ServiceDetailView locale={locale} id="missing" />
      </Providers>,
    );
    expect(await screen.findByText(translate(locale, 'services.detail.notFound'))).toBeTruthy();
    expect(
      screen.getByRole('link', { name: translate(locale, 'services.detail.back') }).getAttribute('href'),
    ).toBe('/' + locale + '/services');
  });
});
