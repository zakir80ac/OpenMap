// T-065 REQ-UI-013 REQ-BSM-003 REQ-AI-004 — ImpactView: explorer → condition → run (saveScenario, runSimulation) →
// results and assistant, plus saved scenarios, over stubbed GraphQL in en and ar.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useCan: () => () => true }));

import { Providers } from '@/providers';
import { ImpactView } from './ImpactView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/impact',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const ci = (id: string, layer: string, type: string, displayName: string, health = 'healthy') => ({ id, name: id, displayName, type, layer, health });

const pg = ci('db-1', 'databases', 'database', 'pg-core-01', 'down');
const host = ci('host-1', 'hardware', 'host', 'db-ryd-pg-core-01');
const app = ci('app-1', 'applications', 'application', 'app-ledger-02');
const svc = ci('svc-1', 'applications', 'business_service', 'Online banking');

const calls: Array<{ op: string; variables: Record<string, unknown> | undefined }> = [];

const simulation = {
  id: 'sim-1',
  ranAt: '2026-10-22T09:30:00.000Z',
  durationMs: 212,
  scenario: { id: 'sc-1', name: 'Failed · pg-core-01', kind: 'failed', options: {}, createdBy: 'syed', createdAt: '2026-10-22T09:29:00.000Z', failedCis: [pg] },
  failedCis: [pg],
  affectedApplications: [app],
  services: [
    {
      service: svc,
      tier: 1,
      predicted: 'down',
      path: ['db-1', 'app-1', 'svc-1'],
      usersAffected: 2100000,
      revenueAtRiskPerHour: { amount: 1400000, currency: 'SAR' },
      slaBudgetRemainingMinutes: 4,
      recovery: { description: 'promote pg-core-02', estimatedMinutes: 1 },
    },
  ],
  totals: { servicesDown: 1, servicesDegraded: 0, usersAffected: 2100000, revenueAtRiskPerHour: { amount: 1400000, currency: 'SAR' } },
  recommendations: [{ title: 'Promote pg-core-02', rationale: 'Replica is in sync', estimatedMinutes: 1 }],
};

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  calls.push({ op, variables: body.variables });
  switch (op) {
    case 'CisPage':
      return { data: { cis: { totalCount: 3, edges: [{ node: pg }, { node: host }, { node: app }] } } };
    case 'Search':
      return { data: { search: [{ ci: host, score: 1, highlight: null }] } };
    case 'ImpactScenarios':
      return { data: { impactScenarios: [simulation.scenario] } };
    case 'SaveScenario':
      return { data: { saveScenario: simulation.scenario } };
    case 'RunSimulation':
      return { data: { runSimulation: simulation } };
    case 'AskAssistant':
      return { data: { askAssistant: { text: 'Promote the replica first.', cypher: 'MATCH (s:BusinessService) RETURN s', rows: [], cis: [svc] } } };
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
      const body = JSON.parse(raw) as { query: string; variables?: Record<string, unknown> };
      return Promise.resolve(new Response(JSON.stringify(respond(body)), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('ImpactView in %s', (locale) => {
  it('lists components, derives applicable conditions for the selection and runs the model', async () => {
    render(
      <Providers locale={locale}>
        <ImpactView locale={locale} />
      </Providers>,
    );
    expect(screen.getByText(translate(locale, 'impact.condition.pickFirst'))).toBeTruthy();
    const list = await screen.findByRole('list', { name: translate(locale, 'impact.explorer.list') });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    const runButton = screen.getByRole('button', { name: translate(locale, 'impact.run') });
    expect((runButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(list).getByRole('button', { name: /^pg-core-01/ }));
    expect(within(list).getByRole('button', { name: /^pg-core-01/ }).getAttribute('aria-pressed')).toBe('true');
    const conditions = screen.getByRole('radiogroup', { name: translate(locale, 'impact.condition.list') });
    const labels = within(conditions)
      .getAllByRole('radio')
      .map((r) => r.textContent);
    expect(labels[0]).toContain(translate(locale, 'impact.condition.failed.label'));
    expect(labels.some((l) => l.includes(translate(locale, 'impact.condition.power_loss.label')))).toBe(false);
    expect(labels.some((l) => l.includes(translate(locale, 'impact.condition.capacity_exhausted.label')))).toBe(true);

    fireEvent.click(within(conditions).getByRole('radio', { name: new RegExp(translate(locale, 'impact.condition.failed.label')) }));
    expect((runButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(screen.getByText(translate(locale, 'impact.result.propagation'))).toBeTruthy();
    });
    const save = calls.find((c) => c.op === 'SaveScenario');
    expect(save?.variables).toMatchObject({ input: { kind: 'failed', failedCiIds: ['db-1'] } });
    expect(calls.find((c) => c.op === 'RunSimulation')?.variables).toEqual({ scenarioId: 'sc-1' });
    expect(screen.getByRole('link', { name: 'Online banking' })).toBeTruthy();
    expect(screen.getByText(translate(locale, 'impact.predicted.down'), { selector: 'td *' })).toBeTruthy();
    expect(screen.getAllByText(new Intl.NumberFormat(locale).format(2100000), { exact: false }).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByText('Promote the replica first.')).toBeTruthy();
    });
    expect(screen.getByText('MATCH (s:BusinessService) RETURN s')).toBeTruthy();
    expect(screen.getByText('Promote pg-core-02')).toBeTruthy();
    const question = calls.find((c) => c.op === 'AskAssistant')?.variables?.['question'];
    expect(String(question)).toContain('pg-core-01');
  });

  it('re-runs a saved scenario and restores its components and condition', async () => {
    render(
      <Providers locale={locale}>
        <ImpactView locale={locale} />
      </Providers>,
    );
    const rerun = await screen.findByRole('button', { name: translate(locale, 'impact.saved.run') });
    fireEvent.click(rerun);
    await waitFor(() => {
      expect(screen.getByText(translate(locale, 'impact.result.propagation'))).toBeTruthy();
    });
    expect(calls.some((c) => c.op === 'SaveScenario')).toBe(false);
    expect(screen.getByText(translate(locale, 'impact.explorer.selected', { count: new Intl.NumberFormat(locale).format(1) }))).toBeTruthy();
    expect(screen.getByRole('radio', { name: new RegExp(translate(locale, 'impact.condition.failed.label')) }).getAttribute('aria-checked')).toBe('true');
  });

  it('narrows the explorer by search text through the search query', async () => {
    render(
      <Providers locale={locale}>
        <ImpactView locale={locale} />
      </Providers>,
    );
    await screen.findByRole('list', { name: translate(locale, 'impact.explorer.list') });
    fireEvent.change(screen.getByRole('searchbox', { name: translate(locale, 'impact.explorer.search') }), { target: { value: 'ryd' } });
    await waitFor(() => {
      expect(calls.some((c) => c.op === 'Search' && c.variables?.['text'] === 'ryd')).toBe(true);
    });
    await waitFor(() => {
      const list = screen.getByRole('list', { name: translate(locale, 'impact.explorer.list') });
      expect(within(list).getAllByRole('button')).toHaveLength(1);
    });
  });
});
