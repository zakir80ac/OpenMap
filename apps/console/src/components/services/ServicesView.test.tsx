// T-066 REQ-UI-012 REQ-BSM-002 — ServicesView groups services by state, filters, links root causes and acknowledges
// incidents through the mutation, in en and ar over stubbed GraphQL.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useCan: () => () => true }));

import { Providers } from '@/providers';
import { SERVICE_GROUP_ORDER, ServicesView, errorBudgetPercent, groupServices } from './ServicesView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/services',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const ci = (id: string, displayName: string) => ({ id, name: id, displayName, type: 'business_service', layer: 'applications', health: 'healthy' });

const services = [
  { service: ci('svc-bank', 'Online banking'), state: 'down', since: '2026-10-22T09:27:15.000Z', rootCauses: [ci('pdu-b', 'PDU-R12-B')], slaTarget: 99.95, errorBudgetRemainingMinutes: 4.8 },
  { service: ci('svc-pay', 'Payments gateway'), state: 'degraded', since: '2026-10-22T09:28:00.000Z', rootCauses: [], slaTarget: 99.9, errorBudgetRemainingMinutes: 120 },
  { service: ci('svc-hr', 'HR portal'), state: 'healthy', since: '2026-09-01T00:00:00.000Z', rootCauses: [], slaTarget: 99.5, errorBudgetRemainingMinutes: 3000 },
  { service: ci('svc-crm', 'CRM'), state: 'healthy', since: '2026-09-01T00:00:00.000Z', rootCauses: [], slaTarget: 99.5, errorBudgetRemainingMinutes: -12 },
];

const incident = {
  id: 'inc-1',
  service: ci('svc-bank', 'Online banking'),
  openedAt: '2026-10-22T09:27:15.000Z',
  resolvedAt: null,
  rootCause: ci('pdu-b', 'PDU-R12-B'),
  alerts: 11,
  links: [{ integration: { id: 'int-1', vendor: 'servicenow', name: 'ServiceNow prod' }, remoteId: 'INC0412', remoteUrl: null, remoteState: 'open', syncedAt: '2026-10-22T09:30:00.000Z' }],
};

const calls: string[] = [];

function respond(body: { query: string }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  calls.push(op);
  switch (op) {
    case 'Services':
      return { data: { services } };
    case 'Incidents':
      return { data: { incidents: [incident] } };
    case 'AcknowledgeIncident':
      return { data: { acknowledgeIncident: { ...incident, alerts: 11 } } };
    default:
      return { errors: [{ message: 'unexpected operation ' + op }] };
  }
}

beforeEach(() => {
  calls.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      return Promise.resolve(new Response(JSON.stringify(respond(JSON.parse(raw) as { query: string })), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
});

describe.each(LOCALES)('ServicesView in %s', (locale) => {
  it('renders grouped services with root causes, SLA target and budget, and the incidents panel', async () => {
    render(
      <Providers locale={locale}>
        <ServicesView locale={locale} />
      </Providers>,
    );
    expect((await screen.findAllByRole('link', { name: 'Online banking' })).length).toBeGreaterThan(0);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toContain(translate(locale, 'services.group.down'));
    expect(screen.getByRole('link', { name: 'PDU-R12-B' }).getAttribute('href')).toBe('/' + locale + '/cmdb/pdu-b');
    expect(screen.getByText(translate(locale, 'services.slaTarget', { target: new Intl.NumberFormat(locale).format(99.95) }))).toBeTruthy();
    expect(screen.getByText(translate(locale, 'services.errorBudgetExhausted', { minutes: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(12) }))).toBeTruthy();
    const aside = screen.getByRole('complementary');
    expect(within(aside).getByText(translate(locale, 'services.incidents.alerts', { count: new Intl.NumberFormat(locale).format(11) }))).toBeTruthy();
    expect(within(aside).getByText('servicenow · INC0412 · open')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: new RegExp(translate(locale, 'services.showInMap')) })[0]?.getAttribute('href')).toBe('/' + locale + '/dependencies?ci=svc-bank&direction=downstream');
  });

  it('filters by state through the chips', async () => {
    render(
      <Providers locale={locale}>
        <ServicesView locale={locale} />
      </Providers>,
    );
    await screen.findAllByRole('link', { name: 'Online banking' });
    const filter = screen.getByRole('group', { name: translate(locale, 'services.filter') });
    fireEvent.click(within(filter).getByRole('button', { name: translate(locale, 'health.healthy') }));
    expect(screen.queryByRole('heading', { level: 2, name: new RegExp(translate(locale, 'services.group.down')) })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: new RegExp(translate(locale, 'services.group.healthy')) })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'HR portal' })).toBeTruthy();
    // The incident panel still lists the down service; only the service list is filtered.
    expect(within(screen.getByRole('complementary')).getByRole('link', { name: 'Online banking' })).toBeTruthy();
  });

  it('acknowledges an incident through the mutation and refreshes', async () => {
    render(
      <Providers locale={locale}>
        <ServicesView locale={locale} />
      </Providers>,
    );
    const button = await screen.findByRole('button', { name: translate(locale, 'services.incidents.acknowledge') });
    fireEvent.click(button);
    await waitFor(() => {
      expect(calls).toContain('AcknowledgeIncident');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: translate(locale, 'services.incidents.acknowledged') })).toBeTruthy();
    });
  });
});
