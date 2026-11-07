// T-065 REQ-UI-013 REQ-BSM-003 REQ-AI-004 — ImpactView: explorer → condition → run (saveScenario, runSimulation) →
// results and assistant, plus saved scenarios, over stubbed GraphQL in en and ar. T-468 REQ-BSM-004: the prediction
// accuracy panel shows the mean, the latest validation with its missed service, and accepts a suggestion. T-474
// REQ-BSM-005: the runbook editor saves a runbook with an automated and a manual step, and a saved scenario takes it.
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
const savedRunbooks: Array<Record<string, unknown>> = [];

const comp = ci('cmp-1', 'applications', 'application_component', 'ledger-api');
const cards = ci('svc-2', 'applications', 'business_service', 'Cards');
const loans = ci('svc-3', 'applications', 'business_service', 'Loans');
const accuracy = {
  validated: 12,
  meanAccuracy: 0.75,
  exact: 7,
  pending: 3,
  withoutRootCause: 1,
  recent: [
    {
      incident: { id: 'inc-1', title: 'Cards down', resolvedAt: '2026-11-07T10:00:00.000Z' },
      rootCause: comp,
      predictedServices: [cards],
      actualServices: [cards, loans],
      missedServices: [loans],
      unexpectedServices: [],
      accuracy: 0.5,
      validatedAt: '2026-11-07T10:01:00.000Z',
    },
  ],
};
const suggestion = { id: 'sg-1', type: 'part_of_service', occurrences: 2, state: 'open', updatedAt: '2026-11-07T10:01:00.000Z', from: comp, to: loans, lastIncident: { id: 'inc-1', title: 'Cards down' } };

const simulation = {
  id: 'sim-1',
  ranAt: '2026-10-22T09:30:00.000Z',
  durationMs: 212,
  scenario: { id: 'sc-1', name: 'Failed · pg-core-01', kind: 'failed', options: {}, createdBy: 'syed', createdAt: '2026-10-22T09:29:00.000Z', failedCis: [pg], runbook: null },
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
    case 'ImpactAccuracy':
      return { data: { impactAccuracy: accuracy } };
    case 'RelationshipSuggestions':
      return { data: { relationshipSuggestions: calls.some((c) => c.op === 'AcceptSuggestion') ? [] : [suggestion] } };
    case 'AcceptSuggestion':
      return { data: { acceptRelationshipSuggestion: { ...suggestion, state: 'accepted' } } };
    case 'ValidateImpactPredictions':
      return { data: { validateImpactPredictions: accuracy } };
    case 'Runbooks':
      return { data: { runbooks: savedRunbooks } };
    case 'Integrations':
      return { data: { integrations: [{ id: 'int-awx', category: 'automation', vendor: 'ansible_awx', name: 'AWX', enabled: true, direction: 'outbound', health: 'healthy', lastSuccessAt: null, lastError: null, deliveredLastHour: 0, failedLastHour: 0 }, { id: 'int-sn', category: 'itsm', vendor: 'servicenow', name: 'ServiceNow', enabled: true, direction: 'outbound', health: 'healthy', lastSuccessAt: null, lastError: null, deliveredLastHour: 0, failedLastHour: 0 }] } };
    case 'UpsertRunbook': {
      const input = body.variables?.['input'] as { code: string; title: string; ownerTeam: string; steps: unknown[] };
      const saved = { id: 'rb-1', ...input, lastReviewedAt: null, estimatedMinutes: 15, updatedAt: '2026-11-08T00:00:00.000Z', steps: [] };
      savedRunbooks.push(saved);
      return { data: { upsertRunbook: saved } };
    }
    case 'SetScenarioRunbook':
      return { data: { setScenarioRunbook: { id: 'sc-1' } } };
    case 'AskAssistant':
      return { data: { askAssistant: { text: 'Promote the replica first.', cypher: 'MATCH (s:BusinessService) RETURN s', rows: [], cis: [svc] } } };
    default:
      return { errors: [{ message: 'unexpected operation ' + op }] };
  }
}

beforeEach(() => {
  calls.length = 0;
  savedRunbooks.length = 0;
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

  it('T-468 shows the prediction accuracy and accepts a suggested relationship', async () => {
    render(
      <Providers locale={locale}>
        <ImpactView locale={locale} />
      </Providers>,
    );
    const panel = await screen.findByRole('region', { name: translate(locale, 'impact.accuracy.title') });
    await waitFor(() => {
      expect(within(panel).getByText(new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(75), { exact: false })).toBeTruthy();
    });
    const table = within(panel).getByRole('table', { name: translate(locale, 'impact.accuracy.recent') });
    expect(within(table).getByText('Cards down')).toBeTruthy();
    expect(within(table).getAllByRole('link', { name: 'Loans' }).length).toBeGreaterThan(0);
    const edge = translate(locale, 'impact.suggestions.edge', { from: 'ledger-api', to: 'Loans' });
    expect(within(panel).getByText(edge)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: translate(locale, 'impact.suggestions.accept') }));
    await waitFor(() => {
      expect(calls.find((c) => c.op === 'AcceptSuggestion')?.variables).toEqual({ id: 'sg-1' });
    });
    await waitFor(() => {
      expect(within(panel).getByText(translate(locale, 'impact.suggestions.empty'))).toBeTruthy();
    });
  });

  it('T-474 writes a runbook with an automated step and attaches it to a saved scenario', async () => {
    render(
      <Providers locale={locale}>
        <ImpactView locale={locale} />
      </Providers>,
    );
    const panel = await screen.findByRole('region', { name: translate(locale, 'impact.runbooks.title') });
    await within(panel).findByText(translate(locale, 'impact.runbooks.empty'));
    fireEvent.click(within(panel).getByRole('button', { name: translate(locale, 'impact.runbooks.new') }));
    const form = within(panel).getByRole('form', { name: translate(locale, 'impact.runbooks.editor') });
    const type = (label: string, value: string, nth = 0): void => {
      const field = within(form).getAllByLabelText(label)[nth];
      if (field === undefined) throw new Error('no field ' + label);
      fireEvent.change(field, { target: { value } });
    };
    type(translate(locale, 'impact.runbooks.code'), 'RB-DB-01');
    type(translate(locale, 'impact.runbooks.name'), 'Database failover');
    type(translate(locale, 'impact.runbooks.owner'), 'DBA');
    type(translate(locale, 'impact.runbooks.step', { order: new Intl.NumberFormat(locale).format(1) }), 'Fail over the database');
    type(translate(locale, 'impact.runbooks.stepMinutes'), '10');
    // Only SOAR and automation integrations are offered.
    const integration = within(form).getByLabelText(translate(locale, 'impact.runbooks.integration'));
    expect(within(integration).queryByRole('option', { name: 'ServiceNow' })).toBeNull();
    await within(integration).findByRole('option', { name: 'AWX' });
    fireEvent.change(integration, { target: { value: 'int-awx' } });
    type(translate(locale, 'impact.runbooks.action'), '42');
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'impact.runbooks.addStep') }));
    type(translate(locale, 'impact.runbooks.step', { order: new Intl.NumberFormat(locale).format(2) }), 'Confirm reconnection');
    type(translate(locale, 'impact.runbooks.stepMinutes'), '5', 1);
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'impact.runbooks.save') }));
    await waitFor(() => {
      expect(calls.find((c) => c.op === 'UpsertRunbook')?.variables).toEqual({
        id: null,
        input: {
          code: 'RB-DB-01',
          title: 'Database failover',
          ownerTeam: 'DBA',
          lastReviewedAt: null,
          steps: [
            { order: 1, instruction: 'Fail over the database', estimatedMinutes: 10, automation: { integrationId: 'int-awx', action: '42' } },
            { order: 2, instruction: 'Confirm reconnection', estimatedMinutes: 5, automation: null },
          ],
        },
      });
    });
    const picker = await screen.findByLabelText(translate(locale, 'impact.runbooks.forScenario', { name: 'Failed · pg-core-01' }));
    await within(picker).findByRole('option', { name: 'RB-DB-01' });
    fireEvent.change(picker, { target: { value: 'rb-1' } });
    await waitFor(() => {
      expect(calls.find((c) => c.op === 'SetScenarioRunbook')?.variables).toEqual({ scenarioId: 'sc-1', runbookId: 'rb-1' });
    });
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
