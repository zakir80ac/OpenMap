// T-100 REQ-UI-009 — Assets in en and ar: KPIs and the attention table from `assets`, stage changes through
// `setAssetStage` for operators, plans with their bill of materials and status transitions, a new plan created from
// the form with only the filled bill-of-materials lines, and analysts seeing everything read-only.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';
import { AssetsView, needsAttention, PLAN_NEXT, toBomInput } from './AssetsView';

const roles = { current: ['openmap-operator'] as string[] };
const authValue = (): AuthValue =>
  ({
    status: 'signed-in',
    user: { subject: 's1', username: 'op', displayName: 'Omar Operator', email: 'omar@bank.local', tenant: 'default', roles: roles.current },
    reason: undefined,
    reasonDetail: undefined,
    can: (role: string) => roles.current.includes('openmap-admin') || roles.current.includes(role) || (role === 'openmap-analyst' && roles.current.includes('openmap-operator')),
    getAccessToken: () => 'tok',
    signIn: () => Promise.resolve(undefined),
    completeSignIn: () => Promise.resolve('/'),
    signOut: () => Promise.resolve(undefined),
  }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useAuth: () => authValue(), useCan: () => authValue().can }));

const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
const far = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
const assets = [
  { id: 'a1', ci: { id: 'ci-1', name: 'esx-01', displayName: 'esx-01.bank.local', type: 'host', layer: 'hardware', health: 'healthy' }, assetTag: 'AST-0001', serialNumber: 'SN1', manufacturer: 'Dell', model: 'R760', stage: 'deployed', warrantyEndsAt: soon, supportContract: null, endOfSupport: null, plan: null, purchaseCost: { amount: 12000, currency: 'SAR' } },
  { id: 'a2', ci: null, assetTag: 'AST-0002', serialNumber: null, manufacturer: 'HPE', model: 'DL380', stage: 'planned', warrantyEndsAt: far, supportContract: null, endOfSupport: null, plan: { id: 'p1', number: 'PLAN-001', name: 'Core refresh', status: 'draft' }, purchaseCost: null },
];
const plans = [{ id: 'p1', number: 'PLAN-001', name: 'Core refresh', kind: 'refresh', status: 'draft', bom: [{ description: 'Server', manufacturer: 'HPE', model: 'DL380', sku: null, layer: 'hardware', quantity: 2, received: 0, unitCost: null }], estimatedCost: null, targetSite: null, targetRacks: [], plannedLiveAt: null, assets: [{ id: 'a2', assetTag: 'AST-0002', stage: 'planned' }] }];
const state = { calls: [] as Array<{ op: string; variables: Record<string, unknown> }> };

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  state.calls.push({ op, variables: body.variables ?? {} });
  switch (op) {
    case 'Assets': {
      const v = body.variables ?? {};
      const days = v['warrantyExpiringWithinDays'];
      const stage = v['stage'] as string[] | null | undefined;
      let list = assets;
      if (typeof days === 'number') list = list.filter((a) => new Date(a.warrantyEndsAt).getTime() <= Date.now() + days * 24 * 60 * 60 * 1000);
      if (Array.isArray(stage)) list = list.filter((a) => stage.includes(a.stage));
      return { data: { assets: list } };
    }
    case 'Plans':
      return { data: { plans } };
    case 'SetAssetStage': {
      const v = body.variables as { assetId: string; stage: string };
      const a = assets.find((x) => x.id === v.assetId);
      if (a) a.stage = v.stage;
      return { data: { setAssetStage: a } };
    }
    case 'SetPlanStatus': {
      const v = body.variables as { planId: string; status: string };
      const p = plans.find((x) => x.id === v.planId);
      if (p) p.status = v.status;
      return { data: { setPlanStatus: p } };
    }
    case 'CreatePlan': {
      const input = (body.variables as { input: { name: string; bom: unknown[] } }).input;
      return { data: { createPlan: { ...plans[0], id: 'p2', number: 'PLAN-002', name: input.name, bom: input.bom.map((l) => ({ ...(l as object), received: 0, unitCost: null })), assets: [] } } };
    }
    default:
      return { errors: [{ message: 'unexpected operation ' + op }] };
  }
}

beforeEach(() => {
  state.calls = [];
  roles.current = ['openmap-operator'];
  for (const a of assets.slice(0, 1)) a.stage = 'deployed';
  for (const p of plans.slice(0, 1)) p.status = 'draft';
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
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
      <AssetsView locale={locale} />
    </Providers>,
  );
}

describe('AssetsView helpers', () => {
  it('lists assets losing cover inside the horizon, soonest first', () => {
    const now = new Date();
    const out = needsAttention(assets as never, 30, now);
    expect(out.map((a) => a.assetTag)).toEqual(['AST-0001']);
    expect(PLAN_NEXT.draft).toEqual(['approved', 'cancelled']);
    expect(PLAN_NEXT.live).toEqual([]);
  });

  it('drops blank bill-of-materials lines and omits empty optional fields', () => {
    const lines = [
      { description: 'Switch', manufacturer: '', model: 'N9K', sku: '', layer: 'network_security' as const, quantity: '3', unitCostAmount: '', unitCostCurrency: '' },
      { description: '', manufacturer: 'x', model: '', sku: '', layer: 'hardware' as const, quantity: '1', unitCostAmount: '', unitCostCurrency: '' },
    ];
    expect(toBomInput(lines)).toEqual([{ description: 'Switch', model: 'N9K', layer: 'network_security', quantity: 3 }]);
  });
});

describe.each(LOCALES)('AssetsView (%s)', (locale) => {
  it('shows the attention table, the register and the plans, and lets an operator change a stage and a plan status', async () => {
    mount(locale);
    const tags = await screen.findAllByText('AST-0001');
    // Once in the attention table (warranty ends in ten days) and once in the register.
    expect(tags.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(translate(locale, 'assets.attention.title'))).toBeTruthy();
    expect(screen.getByText('PLAN-001')).toBeTruthy();
    expect(screen.getByText(translate(locale, 'assets.plans.bom.description'), { selector: 'th' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(translate(locale, 'assets.setStage', { tag: 'AST-0001' })), { target: { value: 'spare' } });
    await waitFor(() => {
      expect(state.calls.some((c) => c.op === 'SetAssetStage' && c.variables['stage'] === 'spare')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'assets.plans.to.approved') }));
    await waitFor(() => {
      expect(state.calls.some((c) => c.op === 'SetPlanStatus' && c.variables['status'] === 'approved')).toBe(true);
    });
  });

  it('creates a plan from the form with the filled lines only', async () => {
    mount(locale);
    await screen.findByText('PLAN-001');
    const form = screen.getByRole('form', { name: translate(locale, 'assets.plans.new') });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.plans.name')), { target: { value: 'Edge expansion' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.plans.description')), { target: { value: 'Two more leaf switches' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.plans.bom.description')), { target: { value: 'Leaf switch' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.plans.bom.quantity')), { target: { value: '2' } });
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'assets.plans.create') }));
    await screen.findByRole('status');
    const create = state.calls.find((c) => c.op === 'CreatePlan');
    expect(create?.variables).toEqual({ input: { name: 'Edge expansion', description: 'Two more leaf switches', kind: 'new_infrastructure', bom: [{ description: 'Leaf switch', layer: 'hardware', quantity: 2 }] } });
  });
});

describe('AssetsView (analyst)', () => {
  it('shows stages as tags and no plan form', async () => {
    roles.current = ['openmap-analyst'];
    mount('en');
    await screen.findAllByText('AST-0001');
    expect(screen.queryByLabelText(translate('en', 'assets.setStage', { tag: 'AST-0001' }))).toBeNull();
    expect(screen.queryByRole('form', { name: translate('en', 'assets.plans.new') })).toBeNull();
    expect(screen.getByText(translate('en', 'assets.plans.readOnly'))).toBeTruthy();
  });
});
