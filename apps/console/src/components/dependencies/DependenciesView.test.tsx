// T-061 REQ-UI-007 REQ-DEP-003 — DependenciesView renders the toolbar, lane chips, canvas model and impact panel from
// stubbed GraphQL responses in both locales; the Sigma canvas is replaced by a probe that lists the nodes it receives.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { GRAPH } from '@openmap/constants';
import { CI_LAYERS } from '@openmap/contracts';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYER_VISIBILITY_STORAGE_KEY, allLayersVisible } from '@/hooks/useLayerVisibility';
import { Providers } from '@/providers';
import type { DependencyCanvasProps } from './DependencyCanvas';
import { DependenciesView, parseDepth, toAsOf, toLocalInput } from './DependenciesView';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/en/dependencies',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('./DependencyCanvas', () => ({
  DependencyCanvas: ({ graph, positions, lanes, label }: DependencyCanvasProps) => (
    <div role="img" aria-label={label} data-testid="canvas-probe" data-lanes={lanes.map((l) => l.layer).join(',')}>
      {graph.nodes.map((node) => (
        <span key={node.id} data-testid="probe-node" data-x={positions[node.id]?.x} data-y={positions[node.id]?.y}>
          {node.label}
        </span>
      ))}
    </div>
  ),
}));

function ci(id: string, layer: (typeof CI_LAYERS)[number], type: string, displayName: string) {
  return { id, name: id, displayName, type, layer, health: 'healthy' };
}

const impact = {
  root: { ...ci('db-1', 'databases', 'database', 'pg-core-01'), health: 'down' },
  durationMs: 184,
  nodes: [
    { ci: ci('app-1', 'applications', 'application', 'app-ledger-02'), depth: 1, predicted: 'degraded', path: ['db-1', 'app-1'] },
    { ci: ci('vm-1', 'virtualization', 'vm', 'vm-ledger'), depth: 1, predicted: 'down', path: ['db-1', 'vm-1'] },
    { ci: ci('host-1', 'hardware', 'host', 'esx-ryd-07'), depth: 2, predicted: 'down', path: ['db-1', 'vm-1', 'host-1'] },
  ],
  services: [
    {
      service: ci('svc-1', 'applications', 'business_service', 'Online banking'),
      tier: 1,
      predicted: 'down',
      path: ['db-1', 'app-1', 'svc-1'],
      usersAffected: 2100000,
      revenueAtRiskPerHour: { amount: 1400000, currency: 'SAR' },
      slaBudgetRemainingMinutes: 4.8,
      recovery: { description: 'promote replica', estimatedMinutes: 1 },
    },
  ],
};

const detail = {
  ...impact.root,
  identity: {},
  attributes: {},
  tags: [],
  externalIds: [],
  lifecycle: 'managed',
  userLabel: null,
  source: { collectorId: 'ssh_agentless', nodeId: 'node-1', runId: 'run-1', confidence: 0.98 },
  observedAt: '2026-10-22T09:00:00.000Z',
  validFrom: '2026-03-02T00:00:00.000Z',
  validTo: null,
  relationships: {
    totalCount: 1,
    edges: [{ node: { id: 'rel-1', type: 'runs_on', from: impact.root, to: impact.nodes[1]?.ci, validFrom: '2026-03-02T00:00:00.000Z', validTo: null } }],
  },
};

function respond(body: { query: string }): unknown {
  if (body.query.includes('query Impact(')) return { data: { impact } };
  if (body.query.includes('query CiDetail(')) return { data: { ci: detail } };
  if (body.query.includes('query Search(')) return { data: { search: [] } };
  return { errors: [{ message: 'unexpected operation' }] };
}

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  // The visibility store caches the last raw value in module scope; seed storage so each test starts with every lane shown.
  window.localStorage.setItem(LAYER_VISIBILITY_STORAGE_KEY, JSON.stringify(allLayersVisible()));
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(raw) as { query: string };
      return Promise.resolve(new Response(JSON.stringify(respond(body)), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.push.mockReset();
  router.replace.mockReset();
  window.localStorage.clear();
});

describe('query-string helpers', () => {
  it('bounds depth by the graph limits and falls back to the default', () => {
    expect(parseDepth(undefined)).toBe(GRAPH.defaultImpactDepth);
    expect(parseDepth('3')).toBe(3);
    expect(parseDepth('0')).toBe(GRAPH.defaultImpactDepth);
    expect(parseDepth(String(GRAPH.maxImpactDepth + 1))).toBe(GRAPH.defaultImpactDepth);
    expect(parseDepth('abc')).toBe(GRAPH.defaultImpactDepth);
  });
  it('round-trips an as-of instant through the datetime-local field', () => {
    const iso = '2026-10-21T08:30:00.000Z';
    const local = toLocalInput(iso);
    expect(local).toHaveLength('YYYY-MM-DDTHH:mm'.length);
    expect(toAsOf(local)).toBe(iso);
    expect(toAsOf('')).toBeUndefined();
    expect(toLocalInput(undefined)).toBe('');
  });
});

describe.each(LOCALES)('DependenciesView in %s', (locale) => {
  it('asks for a focus when no CI is given', () => {
    render(
      <Providers locale={locale}>
        <DependenciesView locale={locale} ciId={undefined} direction="upstream" depth={GRAPH.defaultImpactDepth} asOf={undefined} />
      </Providers>,
    );
    expect(screen.getByText(translate(locale, 'dependencies.focus.none'))).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: translate(locale, 'dependencies.toolbar') })).toBeTruthy();
    const lanes = screen.getByRole('group', { name: translate(locale, 'dependencies.lanes.label') });
    expect(within(lanes).getAllByRole('button')).toHaveLength(CI_LAYERS.length);
  });

  it('renders the impact graph, lane model and side panel from the API', async () => {
    render(
      <Providers locale={locale}>
        <DependenciesView locale={locale} ciId="db-1" direction="upstream" depth={4} asOf={undefined} />
      </Providers>,
    );
    const probe = await screen.findByTestId('canvas-probe');
    expect(probe.getAttribute('aria-label')).toBe(translate(locale, 'dependencies.canvas.label', { name: 'pg-core-01' }));
    expect(probe.getAttribute('data-lanes')).toBe('hardware,virtualization,databases,applications');
    const nodes = within(probe).getAllByTestId('probe-node');
    expect(nodes.map((n) => n.textContent).sort()).toEqual(['app-ledger-02', 'esx-ryd-07', 'pg-core-01', 'vm-ledger']);
    const root = nodes.find((n) => n.textContent === 'pg-core-01');
    expect(root?.getAttribute('data-x')).toBe('0');

    expect(screen.getByText(translate(locale, 'dependencies.focusOn', { name: 'pg-core-01' }))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Online banking' })).toBeTruthy();
    expect(screen.getByText(translate(locale, 'dependencies.panel.blastRadius'))).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(translate(locale, 'relationship.runs_on'))).toBeTruthy();
    });
    const depth = screen.getByRole<HTMLSelectElement>('combobox', { name: translate(locale, 'dependencies.depth.label') });
    expect(depth.options).toHaveLength(GRAPH.maxImpactDepth);
    expect(depth.value).toBe('4');
  });

  it('hides a lane and bridges its nodes out of the layout when its chip is toggled', async () => {
    render(
      <Providers locale={locale}>
        <DependenciesView locale={locale} ciId="db-1" direction="upstream" depth={4} asOf={undefined} />
      </Providers>,
    );
    await screen.findByTestId('canvas-probe');
    const lanes = screen.getByRole('group', { name: translate(locale, 'dependencies.lanes.label') });
    within(lanes).getByRole('button', { name: translate(locale, 'layer.virtualization') }).click();
    await waitFor(() => {
      expect(screen.getByTestId('canvas-probe').getAttribute('data-lanes')).toBe('hardware,databases,applications');
    });
    expect(within(lanes).getByRole('button', { name: translate(locale, 'dependencies.lanes.showAll') })).toBeTruthy();
  });
});
