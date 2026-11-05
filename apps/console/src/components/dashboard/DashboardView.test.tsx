// T-123 REQ-UI-030 — DashboardView: no dashboards → the wizard (persona → widgets → details → create); a dashboard →
// its widgets on the grid from live queries; Customize removes a widget and saves through updateDashboard (en, ar).
import { DASHBOARD_TEMPLATES } from '@openmap/contracts';
import { translate, type Locale } from '@openmap/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estateAvailability } from './widgets';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { Dashboard, DashboardWidget } from '@/lib/dashboard-queries';
import { Providers } from '@/providers';
import { DashboardView, moveWidget, pickDashboard } from './DashboardView';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/en/dashboard',
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

interface Call {
  query: string;
  variables: Record<string, unknown> | undefined;
}
const calls: Call[] = [];
let dashboards: Dashboard[] = [];

const ciso: Dashboard = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Security',
  persona: 'ciso',
  owner: 'admin',
  shared: false,
  isDefault: true,
  mine: true,
  widgets: DASHBOARD_TEMPLATES.ciso.map((w, i) => ({
    id: 'w' + String(i),
    kind: w.kind,
    size: w.size,
    options: {},
  })),
  createdAt: '2026-11-04T10:00:00.000Z',
  updatedAt: '2026-11-04T10:00:00.000Z',
};

const stats = {
  assetsByStage: [{ stage: 'deployed', count: 12, purchaseCost: [{ amount: 120000, currency: 'USD' }] }],
  licences: {
    products: 20,
    licensed: 10,
    overDeployed: 1,
    expiringSoon: 2,
    expired: 0,
    annualCost: [{ amount: 50000, currency: 'USD' }],
  },
  vulnerabilities: {
    total: 35,
    critical: 9,
    exploited: 3,
    cisaKev: 2,
    internetFacing: 4,
    patchAvailable: 30,
    affectedHosts: 80,
  },
  endOfSupport: 2,
  plans: [],
  power: { racks: 101, ratedWatts: 500000, currentWatts: 210000 },
  ipam: { subnets: 40, averageUtilisationPercent: 41, critical: 1 },
  nodes: { total: 3, online: 3 },
  integrations: { total: 2, healthy: 2, failedLastHour: 0 },
  incidentsOpen: 1,
  trend: {
    days: ['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'],
    cis: [100, 120],
    discoveryRuns: [2, 3],
    events: [40, 50],
    incidents: [0, 1],
  },
};

function respond(query: string, variables: Record<string, unknown> | undefined): unknown {
  calls.push({ query, variables });
  if (query.includes('query Dashboards')) return { data: { dashboards } };
  if (query.includes('query EstateStats')) return { data: { estateStats: stats } };
  if (query.includes('mutation CreateDashboard')) {
    const input = (
      variables as { input: { name: string; persona: string; widgets: unknown[]; shared: boolean } }
    ).input;
    const created: Dashboard = {
      ...ciso,
      id: '22222222-2222-4222-8222-222222222222',
      name: input.name,
      persona: input.persona as Dashboard['persona'],
      shared: input.shared,
      widgets: input.widgets.map((w, i) => ({ ...(w as DashboardWidget), id: 'n' + String(i) })),
    };
    dashboards = [created];
    return { data: { createDashboard: created } };
  }
  if (query.includes('mutation UpdateDashboard')) {
    const input = (variables as { input: { widgets: unknown[] } }).input;
    const updated: Dashboard = {
      ...ciso,
      widgets: input.widgets.map((w, i) => ({ ...(w as DashboardWidget), id: 'u' + String(i) })),
    };
    dashboards = [updated];
    return { data: { updateDashboard: updated } };
  }
  if (query.includes('query Onboarding'))
    return {
      data: {
        onboarding: {
          step: 'generate',
          completedSteps: [],
          generatedAt: '2026-11-01T00:00:00.000Z',
          organization: null,
          sites: [],
          links: [],
          nodes: [],
          credentials: [],
          scopes: [],
          firstSweep: null,
        },
      },
    };
  if (query.includes('query Services') || query.includes('services('))
    return {
      data: {
        services: [
          {
            service: { id: 's1', name: 'cbs', displayName: 'Core banking' },
            state: 'healthy',
            since: '2026-11-01T00:00:00.000Z',
            rootCauses: [],
            slaTarget: 99.9,
            errorBudgetRemainingMinutes: 43,
          },
        ],
      },
    };
  if (query.includes('layers {') || query.includes('query Layers'))
    return {
      data: {
        layers: [{ layer: 'hardware', count: 120, healthy: 100, degraded: 10, down: 10, visible: true }],
      },
    };
  if (query.includes('integrations(')) return { data: { integrations: [] } };
  if (query.includes('assets(')) return { data: { assets: [] } };
  if (query.includes('availabilityReport(')) {
    const period = (month: number, down: number, met: boolean, current: boolean) => ({
      granularity: 'month',
      year: 2026,
      month,
      quarter: null,
      periodStart: '2026-' + String(month).padStart(2, '0') + '-01T00:00:00.000Z',
      periodEnd: '2026-' + String(month + 1).padStart(2, '0') + '-01T00:00:00.000Z',
      current,
      availabilityPercent: 100 - down / 432,
      elapsedMinutes: 43200,
      downtimeMinutes: down,
      degradedMinutes: 0,
      unknownMinutes: 0,
      targetPercent: 99.9,
      met,
      budgetMinutes: 43.2,
      budgetRemainingMinutes: 43.2 - down,
      burnRate: 1,
    });
    return {
      data: {
        availabilityReport: [
          {
            service: { id: 's1', name: 'cbs', displayName: 'Core banking', code: 'CBS' },
            sla: null,
            periods: [period(10, 0, true, false), period(11, 432, false, true)],
          },
          {
            service: { id: 's2', name: 'hr', displayName: 'HR portal', code: 'HR' },
            sla: null,
            periods: [period(10, 216, true, false), period(11, 0, true, true)],
          },
        ],
      },
    };
  }
  if (query.includes('auditLog('))
    return {
      data: { auditLog: { edges: [], pageInfo: { endCursor: null, hasNextPage: false }, totalCount: 0 } },
    };
  return { data: {} };
}

beforeEach(() => {
  calls.length = 0;
  search = '';
  dashboards = [];
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(raw) as { query: string; variables?: Record<string, unknown> };
      return Promise.resolve(
        new Response(JSON.stringify(respond(body.query, body.variables)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderView(locale: Locale): void {
  render(
    <Providers locale={locale}>
      <DashboardView />
    </Providers>,
  );
}

describe('estateAvailability', () => {
  it('weights the services by observed minutes and ignores unobserved time', () => {
    expect(
      estateAvailability([
        { downtimeMinutes: 60, elapsedMinutes: 1440, unknownMinutes: 0 },
        { downtimeMinutes: 0, elapsedMinutes: 1440, unknownMinutes: 1440 },
      ]),
    ).toBeCloseTo((1380 / 1440) * 100, 6);
    expect(estateAvailability([{ downtimeMinutes: 0, elapsedMinutes: 100, unknownMinutes: 100 }])).toBeNull();
    expect(estateAvailability([])).toBeNull();
  });
});

describe('pickDashboard and moveWidget', () => {
  it('prefers the requested dashboard, then the own default, then any own, then the first shared', () => {
    const shared = { ...ciso, id: 's', mine: false, isDefault: false, owner: 'ops' };
    const own = { ...ciso, id: 'o', isDefault: false };
    expect(pickDashboard([shared, own, ciso], 'o')?.id).toBe('o');
    expect(pickDashboard([shared, own, ciso], null)?.id).toBe(ciso.id);
    expect(pickDashboard([shared, own], null)?.id).toBe('o');
    expect(pickDashboard([shared], null)?.id).toBe('s');
  });
  it('moves a widget within bounds and leaves the ends alone', () => {
    const list = ciso.widgets;
    expect(moveWidget(list, 'w1', -1)[0]?.id).toBe('w1');
    expect(moveWidget(list, 'w0', -1).map((w) => w.id)).toEqual(list.map((w) => w.id));
    expect(moveWidget(list, 'w0', 1)[1]?.id).toBe('w0');
  });
});

describe.each(['en', 'ar'] as const)('DashboardView (%s)', (locale) => {
  it('opens the wizard when the user has no dashboard and creates one from the CISO template', async () => {
    renderView(locale);
    expect(
      await screen.findByRole('heading', { level: 1, name: translate(locale, 'nav.dashboard') }),
    ).toBeTruthy();
    const wizard = await screen.findByRole('region', { name: translate(locale, 'dashboard.wizard.title') });
    fireEvent.click(
      within(wizard).getByRole('radio', {
        name: new RegExp(translate(locale, 'dashboard.persona.ciso.title')),
      }),
    );
    fireEvent.click(within(wizard).getByRole('button', { name: translate(locale, 'common.next') }));
    // Every CISO template widget is pre-ticked.
    const ticked = within(wizard)
      .getAllByRole('checkbox')
      .filter((c) => (c as HTMLInputElement).checked);
    expect(ticked.length).toBe(DASHBOARD_TEMPLATES.ciso.length);
    fireEvent.click(within(wizard).getByRole('button', { name: translate(locale, 'common.next') }));
    fireEvent.click(
      within(wizard).getByRole('button', { name: translate(locale, 'dashboard.wizard.create') }),
    );
    await waitFor(() => {
      expect(calls.some((c) => c.query.includes('mutation CreateDashboard'))).toBe(true);
    });
    const create = calls.find((c) => c.query.includes('mutation CreateDashboard'));
    expect(create?.variables).toMatchObject({
      input: { persona: 'ciso', name: translate(locale, 'dashboard.persona.ciso.title'), shared: false },
    });
    expect((create?.variables as { input: { widgets: unknown[] } }).input.widgets.length).toBe(
      DASHBOARD_TEMPLATES.ciso.length,
    );
    expect(replace).toHaveBeenCalled();
  });

  it('shows the overall uptime tile on an administrator dashboard with the figure, the change and the services below target (REQ-UI-036)', async () => {
    dashboards = [
      {
        ...ciso,
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Administrator',
        persona: 'admin',
        widgets: [{ id: 'a0', kind: 'services.uptime', size: 's', options: {} }],
      },
    ];
    render(
      <Providers locale={locale}>
        <DashboardView />
      </Providers>,
    );
    const grid = await screen.findByRole('region', { name: translate(locale, 'dashboard.widgets') });
    expect(
      await within(grid).findByText(translate(locale, 'dashboard.widget.services.uptime.title')),
    ).toBeTruthy();
    // This month: 432 down minutes over 86,400 observed across the two services → 99.5%; last month 216 → 99.75%.
    const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
    const figure = percent.format(99.5);
    expect(await within(grid).findByText((content) => content.startsWith(figure))).toBeTruthy();
    expect(
      within(grid).getByText(
        translate(locale, 'dashboard.widget.services.uptime.below', {
          below: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(1),
          total: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(2),
        }),
      ),
    ).toBeTruthy();
    expect(
      within(grid).getByText(
        translate(locale, 'dashboard.widget.services.uptime.delta', { points: percent.format(0.25) }),
      ),
    ).toBeTruthy();
  });

  it('renders a dashboard with its widgets from live queries and saves a customisation', async () => {
    dashboards = [ciso];
    renderView(locale);
    const grid = await screen.findByRole('region', { name: translate(locale, 'dashboard.widgets') });
    expect(within(grid).getAllByRole('article').length).toBe(ciso.widgets.length);
    expect(
      await within(grid).findByText(translate(locale, 'dashboard.widget.security.vulnerabilities.title')),
    ).toBeTruthy();
    // The estate aggregate paints the vulnerability figures.
    expect(
      await within(grid).findByText(new Intl.NumberFormat(locale).format(stats.vulnerabilities.total)),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'dashboard.customize') }));
    fireEvent.click(
      within(grid).getAllByRole('button', {
        name: translate(locale, 'dashboard.removeWidget'),
      })[0] as HTMLElement,
    );
    expect(within(grid).getAllByRole('article').length).toBe(ciso.widgets.length - 1);
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'common.save') }));
    await waitFor(() => {
      expect(calls.some((c) => c.query.includes('mutation UpdateDashboard'))).toBe(true);
    });
    const update = calls.find((c) => c.query.includes('mutation UpdateDashboard'));
    expect((update?.variables as { input: { widgets: unknown[] } }).input.widgets.length).toBe(
      ciso.widgets.length - 1,
    );
  });
});
