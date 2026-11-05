// T-100 REQ-UI-009 REQ-CMDB-039 REQ-CMDB-040 — Assets in en and ar: KPIs from `assetSummary`, the attention table
// and the register from `assets` with layer, data-gap and text filters, stage changes through `setAssetStage` for
// operators, the details panel saving warranty cover through `updateAsset`, unknown devices with their diagnosis,
// plans with their bill of materials and status transitions, a new plan created from the form with only the filled
// bill-of-materials lines, and analysts seeing everything read-only.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ASSETS } from '@openmap/constants';
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
    user: {
      subject: 's1',
      username: 'op',
      displayName: 'Omar Operator',
      email: 'omar@bank.local',
      tenant: 'default',
      roles: roles.current,
    },
    reason: undefined,
    reasonDetail: undefined,
    can: (role: string) =>
      roles.current.includes('openmap-admin') ||
      roles.current.includes(role) ||
      (role === 'openmap-analyst' && roles.current.includes('openmap-operator')),
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

const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
const far = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
const DATE_LENGTH = 10;
const soonDate = soon.slice(0, DATE_LENGTH);
interface FixtureAsset {
  id: string;
  ci: {
    id: string;
    name: string;
    displayName: string;
    code: string;
    type: string;
    layer: string;
    health: string;
  } | null;
  ciType: string | null;
  layer: string;
  source: string;
  assetTag: string;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  partNumber: string | null;
  stage: string;
  custodian: string | null;
  purchasedAt: string | null;
  warranty: {
    provider: string;
    level: string | null;
    startsAt: string | null;
    endsAt: string;
    source: string;
    verifiedAt: string | null;
  } | null;
  warrantyEndsAt: string | null;
  support: null;
  supportContract: null;
  supportEndsAt: string | null;
  endOfLife: null;
  endOfSupport: string | null;
  dataGaps: string[];
  plan: { id: string; number: string; name: string; status: string } | null;
  purchaseCost: { amount: number; currency: string } | null;
}
const assets: FixtureAsset[] = [
  {
    id: 'a1',
    ci: {
      id: 'ci-1',
      name: 'esx-01',
      displayName: 'esx-01.bank.local',
      code: 'HW-ESX-01',
      type: 'host',
      layer: 'hardware',
      health: 'healthy',
    },
    ciType: 'host',
    layer: 'hardware',
    source: 'discovery',
    assetTag: 'AST-0001',
    serialNumber: 'SN1',
    manufacturer: 'Dell',
    model: 'R760',
    partNumber: null,
    stage: 'deployed',
    custodian: null,
    purchasedAt: null,
    warranty: {
      provider: 'Dell',
      level: null,
      startsAt: null,
      endsAt: soonDate,
      source: 'vendor_api',
      verifiedAt: null,
    },
    warrantyEndsAt: soon,
    support: null,
    supportContract: null,
    supportEndsAt: null,
    endOfLife: null,
    endOfSupport: null,
    dataGaps: ['support', 'end_of_life'],
    plan: null,
    purchaseCost: { amount: 12000, currency: 'SAR' },
  },
  {
    id: 'a2',
    ci: null,
    ciType: null,
    layer: 'hardware',
    source: 'plan',
    assetTag: 'AST-0002',
    serialNumber: null,
    manufacturer: 'HPE',
    model: 'DL380',
    partNumber: null,
    stage: 'planned',
    custodian: null,
    purchasedAt: null,
    warranty: {
      provider: 'HPE',
      level: null,
      startsAt: null,
      endsAt: far.slice(0, DATE_LENGTH),
      source: 'manual',
      verifiedAt: null,
    },
    warrantyEndsAt: far,
    support: null,
    supportContract: null,
    supportEndsAt: null,
    endOfLife: null,
    endOfSupport: null,
    dataGaps: ['support', 'end_of_life'],
    plan: { id: 'p1', number: 'PLAN-001', name: 'Core refresh', status: 'draft' },
    purchaseCost: null,
  },
  {
    id: 'a3',
    ci: {
      id: 'ci-3',
      name: 'rhel-sub',
      displayName: 'Enterprise Linux Server Subscription',
      code: 'APP-RHEL',
      type: 'software_instance',
      layer: 'applications',
      health: 'healthy',
    },
    ciType: 'software_instance',
    layer: 'applications',
    source: 'discovery',
    assetTag: 'APP-RHEL',
    serialNumber: null,
    manufacturer: 'Red Hat',
    model: 'Enterprise Linux Server Subscription',
    partNumber: null,
    stage: 'deployed',
    custodian: null,
    purchasedAt: null,
    warranty: null,
    warrantyEndsAt: null,
    support: null,
    supportContract: null,
    supportEndsAt: null,
    endOfLife: null,
    endOfSupport: null,
    dataGaps: ['warranty', 'support', 'end_of_life'],
    plan: null,
    purchaseCost: null,
  },
];
const summary = [
  { layer: 'hardware', count: 2, needsData: 2, warrantyExpired: 0, supportExpired: 0, endOfSupportPassed: 0 },
  {
    layer: 'applications',
    count: 1,
    needsData: 1,
    warrantyExpired: 0,
    supportExpired: 0,
    endOfSupportPassed: 0,
  },
];
const unknown = [
  {
    id: 'u1',
    name: 'pdu-unmetered',
    displayName: 'pdu-unmetered-01',
    code: 'UNK-PDU',
    type: 'unknown',
    layer: 'unknown',
    health: 'unknown',
    observedAt: soon,
    attributes: {
      deviceKind: 'pdu',
      snmpReachable: false,
      openPorts: [],
      lastSeen: new Date().toISOString(),
    },
  },
];
const plans = [
  {
    id: 'p1',
    number: 'PLAN-001',
    name: 'Core refresh',
    kind: 'refresh',
    status: 'draft',
    bom: [
      {
        description: 'Server',
        manufacturer: 'HPE',
        model: 'DL380',
        sku: null,
        layer: 'hardware',
        quantity: 2,
        received: 0,
        unitCost: null,
      },
    ],
    estimatedCost: null,
    targetSite: null,
    targetRacks: [],
    plannedLiveAt: null,
    assets: [{ id: 'a2', assetTag: 'AST-0002', stage: 'planned' }],
  },
];
const state = {
  calls: [] as Array<{ op: string; variables: Record<string, unknown> }>,
  bulk: false,
  failAfter: false,
};
/** Three pages of rows render three times over; the paging test gets a longer budget than vitest's default on a busy host. */
const PAGING_TEST_TIMEOUT_MS = 30_000;
/** Two full register pages and a short third one, so paging past the first page can be exercised. */
const bulkCount = ASSETS.registerPageSize * 2 + 5;
const bulkBase: FixtureAsset =
  assets[0] ??
  (() => {
    throw new Error('fixture needed');
  })();
const bulk: FixtureAsset[] = Array.from({ length: bulkCount }, (_, i) => ({
  ...bulkBase,
  id: 'b' + String(i).padStart(4, '0'),
  assetTag: 'BULK-' + String(i).padStart(4, '0'),
  ci: null,
  ciType: null,
  source: 'discovery',
}));
function decodeIdCursor(after: unknown): string | null {
  if (typeof after !== 'string') return null;
  const json = atob(after.replace(/-/g, '+').replace(/_/g, '/'));
  return (JSON.parse(json) as { id: string }).id;
}

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  state.calls.push({ op, variables: body.variables ?? {} });
  switch (op) {
    case 'Assets': {
      const v = body.variables ?? {};
      const days = v['warrantyExpiringWithinDays'];
      const stage = v['stage'] as string[] | null | undefined;
      const filter = v['filter'] as
        { layers?: string[] | null; dataGaps?: string[] | null; text?: string | null } | null | undefined;
      let list = assets;
      if (typeof days === 'number')
        list = list.filter(
          (a) =>
            a.warrantyEndsAt !== null &&
            new Date(a.warrantyEndsAt).getTime() <= Date.now() + days * 24 * 60 * 60 * 1000,
        );
      if (Array.isArray(stage)) list = list.filter((a) => stage.includes(a.stage));
      const layers = filter?.layers;
      if (layers) list = list.filter((a) => layers.includes(a.layer));
      const gaps = filter?.dataGaps;
      if (gaps) list = list.filter((a) => a.dataGaps.some((g) => gaps.includes(g)));
      const text = filter?.text?.toLowerCase();
      if (text)
        list = list.filter((a) =>
          [a.assetTag, a.manufacturer ?? '', a.model ?? ''].join(' ').toLowerCase().includes(text),
        );
      if (state.bulk && typeof days !== 'number') {
        const afterId = decodeIdCursor(v['after']);
        if (afterId !== null && state.failAfter) return { errors: [{ message: 'invalid cursor' }] };
        const start = afterId === null ? 0 : bulk.findIndex((a) => a.id === afterId) + 1;
        const first = typeof v['first'] === 'number' ? v['first'] : bulk.length;
        return { data: { assets: bulk.slice(start, start + first) } };
      }
      return { data: { assets: list } };
    }
    case 'AssetSummary':
      return { data: { assetSummary: summary } };
    case 'AssetAudits':
      return {
        data: {
          assets: [
            {
              id: 'a1',
              audits: [
                {
                  id: 'au1',
                  actor: 'op',
                  at: soon,
                  field: 'stage',
                  fromValue: null,
                  toValue: 'deployed',
                  note: null,
                },
              ],
            },
          ],
        },
      };
    case 'UnknownCis':
      return {
        data: { unknownCis: { totalCount: unknown.length, edges: unknown.map((node) => ({ node })) } },
      };
    case 'CreateAsset': {
      const v = body.variables as { input: { layer: string; type: string; name: string } };
      return {
        data: {
          createAsset: {
            ...assets[0],
            id: 'a9',
            assetTag: 'DC-PDU-RACK-7-LEFT',
            layer: v.input.layer,
            ciType: v.input.type,
            source: 'manual',
            ci: {
              id: 'ci-9',
              name: v.input.name,
              displayName: v.input.name,
              code: 'DC-PDU-RACK-7-LEFT',
              type: v.input.type,
              layer: v.input.layer,
              health: 'unknown',
            },
          },
        },
      };
    }
    case 'LabelCi':
      return {
        data: {
          labelCi: {
            id: 'u1',
            name: 'pdu-unmetered',
            displayName: 'pdu-unmetered-01',
            code: 'DC-PDU',
            type: 'pdu',
            layer: 'dc',
            health: 'unknown',
          },
        },
      };
    case 'UpdateAsset': {
      const v = body.variables as {
        assetId: string;
        input: { warranty?: { provider: string; endsAt: string } | null };
      };
      const a = assets.find((x) => x.id === v.assetId);
      if (a && v.input.warranty) {
        a.warranty = {
          provider: v.input.warranty.provider,
          level: null,
          startsAt: null,
          endsAt: v.input.warranty.endsAt,
          source: 'manual',
          verifiedAt: soon,
        };
        a.warrantyEndsAt = v.input.warranty.endsAt;
        a.dataGaps = a.dataGaps.filter((g) => g !== 'warranty');
      }
      return { data: { updateAsset: a } };
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
      return {
        data: {
          createPlan: {
            ...plans[0],
            id: 'p2',
            number: 'PLAN-002',
            name: input.name,
            bom: input.bom.map((l) => ({ ...(l as object), received: 0, unitCost: null })),
            assets: [],
          },
        },
      };
    }
    default:
      return { errors: [{ message: 'unexpected operation ' + op }] };
  }
}

beforeEach(() => {
  state.calls = [];
  state.bulk = false;
  state.failAfter = false;
  roles.current = ['openmap-operator'];
  for (const a of assets.slice(0, 1)) a.stage = 'deployed';
  for (const p of plans.slice(0, 1)) p.status = 'draft';
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
      {
        description: 'Switch',
        manufacturer: '',
        model: 'N9K',
        sku: '',
        layer: 'network_security' as const,
        quantity: '3',
        unitCostAmount: '',
        unitCostCurrency: '',
      },
      {
        description: '',
        manufacturer: 'x',
        model: '',
        sku: '',
        layer: 'hardware' as const,
        quantity: '1',
        unitCostAmount: '',
        unitCostCurrency: '',
      },
    ];
    expect(toBomInput(lines)).toEqual([
      { description: 'Switch', model: 'N9K', layer: 'network_security', quantity: 3 },
    ]);
  });
});

describe.each(LOCALES)('AssetsView (%s)', (locale) => {
  it('shows the attention table, the register and the plans, and lets an operator change a stage and a plan status', async () => {
    mount(locale);
    const tags = await screen.findAllByText('AST-0001');
    // Once in the attention table (warranty ends in ten days) and once in the register.
    expect(tags.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(translate(locale, 'assets.attention.title'))).toBeTruthy();
    expect(screen.getAllByText('PLAN-001').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(translate(locale, 'assets.plans.bom.description'), { selector: 'th' }).length,
    ).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(translate(locale, 'assets.setStage', { tag: 'AST-0001' })), {
      target: { value: 'spare' },
    });
    await waitFor(() => {
      expect(state.calls.some((c) => c.op === 'SetAssetStage' && c.variables['stage'] === 'spare')).toBe(
        true,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'assets.plans.to.approved') }));
    await waitFor(() => {
      expect(state.calls.some((c) => c.op === 'SetPlanStatus' && c.variables['status'] === 'approved')).toBe(
        true,
      );
    });
  });

  it('creates a plan from the form with the filled lines only', async () => {
    mount(locale);
    await screen.findAllByText('PLAN-001');
    const form = screen.getByRole('form', { name: translate(locale, 'assets.plans.new') });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.plans.name')), {
      target: { value: 'Edge expansion' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.plans.description')), {
      target: { value: 'Two more leaf switches' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.plans.bom.description')), {
      target: { value: 'Leaf switch' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.plans.bom.quantity')), {
      target: { value: '2' },
    });
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'assets.plans.create') }));
    await screen.findByRole('status');
    const create = state.calls.find((c) => c.op === 'CreatePlan');
    expect(create?.variables).toEqual({
      input: {
        name: 'Edge expansion',
        description: 'Two more leaf switches',
        kind: 'new_infrastructure',
        bom: [{ description: 'Leaf switch', layer: 'hardware', quantity: 2 }],
      },
    });
  });
});

describe.each(LOCALES)('AssetsView register (%s)', (locale) => {
  it('sums the summary into KPIs, filters the register by layer, data gap and text, and shows cover gaps', async () => {
    mount(locale);
    await screen.findAllByText('AST-0001');
    // KPIs: 3 owned, 3 with a gap.
    expect(screen.getByText(translate(locale, 'assets.kpi.owned')).parentElement?.textContent).toContain('3');
    const register = screen.getByTestId('asset-register');
    expect(within(register).getAllByRole('row')).toHaveLength(1 + assets.length);
    // Missing cover reads as a gap tag, a software instance is listed under its layer with no make invented.
    expect(within(register).getAllByText(translate(locale, 'assets.table.missing')).length).toBeGreaterThan(
      0,
    );
    expect(within(register).getByText('Red Hat Enterprise Linux Server Subscription')).toBeTruthy();

    const strip = screen.getByRole('group', { name: translate(locale, 'assets.register.layers') });
    fireEvent.click(
      within(strip).getByRole('button', { name: new RegExp(translate(locale, 'layer.applications')) }),
    );
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.op === 'Assets' && JSON.stringify(c.variables['filter']).includes('"applications"'),
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(within(screen.getByTestId('asset-register')).getAllByRole('row')).toHaveLength(2);
    });

    fireEvent.change(screen.getByLabelText(translate(locale, 'assets.filter.data')), {
      target: { value: 'warranty' },
    });
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.op === 'Assets' && JSON.stringify(c.variables['filter']).includes('"warranty"'),
        ),
      ).toBe(true);
    });

    fireEvent.change(screen.getByLabelText(translate(locale, 'assets.filter.text')), {
      target: { value: 'dell' },
    });
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.op === 'Assets' && JSON.stringify(c.variables['filter']).includes('"dell"'),
        ),
      ).toBe(true);
    });
  });

  it(
    'pages the register past the first page with the id cursor, stops at a short page, and offers a retry after a failed page',
    async () => {
      state.bulk = true;
      mount('en');
      const register = await screen.findByTestId('asset-register');
      expect(within(register).getAllByRole('row')).toHaveLength(ASSETS.registerPageSize + 1);
      expect(
        screen.getByText(translate('en', 'assets.table.showing', { count: String(ASSETS.registerPageSize) })),
      ).toBeTruthy();

      state.failAfter = true;
      fireEvent.click(screen.getByRole('button', { name: translate('en', 'common.more') }));
      expect((await screen.findByRole('alert')).textContent).toBe(translate('en', 'common.error'));
      expect(within(register).getAllByRole('row')).toHaveLength(ASSETS.registerPageSize + 1);

      state.failAfter = false;
      fireEvent.click(screen.getByRole('button', { name: translate('en', 'common.retry') }));
      await waitFor(() => {
        expect(within(register).getAllByRole('row')).toHaveLength(ASSETS.registerPageSize * 2 + 1);
      });
      expect(screen.queryByRole('alert')).toBeNull();
      const second = state.calls
        .filter((c) => c.op === 'Assets' && typeof c.variables['after'] === 'string')
        .at(-1);
      expect(decodeIdCursor(second?.variables['after'])).toBe(bulk[ASSETS.registerPageSize - 1]?.id);
      expect(second?.variables['first']).toBe(ASSETS.registerPageSize);

      fireEvent.click(screen.getByRole('button', { name: translate('en', 'common.more') }));
      await waitFor(() => {
        expect(within(register).getAllByRole('row')).toHaveLength(bulkCount + 1);
      });
      expect(screen.queryByRole('button', { name: translate('en', 'common.more') })).toBeNull();
    },
    PAGING_TEST_TIMEOUT_MS,
  );

  it('opens the details panel for a row and saves warranty cover through updateAsset', async () => {
    mount(locale);
    await screen.findAllByText('APP-RHEL');
    fireEvent.click(
      screen.getByRole('button', { name: translate(locale, 'assets.table.edit', { tag: 'APP-RHEL' }) }),
    );
    const panel = await screen.findByTestId('asset-details-panel');
    const form = within(panel).getByRole('form', { name: translate(locale, 'assets.details.title') });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.details.warranty.provider')), {
      target: { value: 'Red Hat' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.details.warranty.endsAt')), {
      target: { value: '2028-06-30' },
    });
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'assets.details.save') }));
    await within(panel).findByRole('status');
    const update = state.calls.find((c) => c.op === 'UpdateAsset');
    expect(update?.variables['assetId']).toBe('a3');
    const input = update?.variables['input'] as {
      warranty: unknown;
      support: unknown;
      endOfLife: unknown;
      manufacturer: string;
    };
    expect(input.warranty).toEqual({
      provider: 'Red Hat',
      level: null,
      startsAt: null,
      endsAt: '2028-06-30',
    });
    // Support and end of life were left empty: they are cleared explicitly, the identity fields echo the row.
    expect(input.support).toBeNull();
    expect(input.manufacturer).toBe('Red Hat');
  });

  it('diagnoses unknown devices and opens the label panel preset with the suggested layer and type', async () => {
    mount(locale);
    const device = await screen.findByTestId('unknown-device');
    expect(device.getAttribute('data-kind')).toBe('no_management');
    expect(device.getAttribute('data-stale')).toBeNull();
    expect(
      within(device).getByText(translate(locale, 'assets.unknown.kind.no_management.title')),
    ).toBeTruthy();
    expect(within(device).getByText(translate(locale, 'assets.unknown.manualOnly'))).toBeTruthy();
    fireEvent.click(
      within(device).getByRole('button', { name: translate(locale, 'cmdb.detail.label.title') }),
    );
    const layerSelect = await within(device).findByLabelText<HTMLSelectElement>(
      translate(locale, 'cmdb.detail.label.layer'),
    );
    expect(layerSelect.value).toBe('dc');
    expect(
      within(device).getByLabelText<HTMLSelectElement>(translate(locale, 'cmdb.detail.label.type')).value,
    ).toBe('pdu');
  });

  it('records an unmanaged asset through createAsset with the chosen layer and type', async () => {
    mount(locale);
    await screen.findAllByText('AST-0001');
    const form = screen.getByRole('form', { name: translate(locale, 'assets.manual.title') });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.manual.name')), {
      target: { value: 'PDU rack 7 left' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'assets.details.manufacturer')), {
      target: { value: 'APC' },
    });
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'assets.manual.create') }));
    await within(form).findByRole('status');
    const create = state.calls.find((c) => c.op === 'CreateAsset');
    const input = create?.variables['input'] as {
      layer: string;
      type: string;
      name: string;
      details: { manufacturer: string };
    };
    expect(input.layer).toBe('dc');
    expect(input.type).toBe('pdu');
    expect(input.name).toBe('PDU rack 7 left');
    expect(input.details.manufacturer).toBe('APC');
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
