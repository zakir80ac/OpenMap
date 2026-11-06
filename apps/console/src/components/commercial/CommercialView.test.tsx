// T-184 REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 (ADR-035) — Vendors and contracts in en and ar: the contract
// register with days left, notice date, cost, coverage and documents (a web address opens, a share path is text); the
// kind and horizon filters reach the query; an operator adds a contract (blank document rows dropped, currency upper
// case) and edits one; a vendor opens its escalation path in level order, gains and loses a contact; cost centres list
// budget against contract cost and add a department; analysts see everything without the editing controls.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';
import { CommercialView } from './CommercialView';
import { endState, isLink, toContractInput } from './ContractsTab';
import { toContactInput } from './VendorsTab';

const roles = { current: ['openmap-operator'] as string[] };
const authValue = (): AuthValue =>
  ({
    status: 'signed-in',
    user: { subject: 's1', username: 'op', displayName: 'Omar Operator', email: 'omar@bank.local', tenant: 'default', roles: roles.current },
    reason: undefined,
    reasonDetail: undefined,
    can: (role: string) => roles.current.includes(role) || (role === 'openmap-analyst' && roles.current.includes('openmap-operator')),
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

const ci = (id: string, type: string, displayName: string) => ({ id, name: displayName, displayName, code: id.toUpperCase(), type, layer: 'applications', health: 'healthy' });
const dell = ci('v1', 'vendor', 'Dell Technologies');
const centre = ci('cc1', 'cost_centre', 'Retail Banking Technology');
const contracts = [
  {
    ci: ci('k1', 'contract', 'ProSupport Plus'),
    kind: 'support',
    contractNumber: 'DELL-1',
    title: 'ProSupport Plus',
    level: 'four_hour',
    responseMinutes: 240,
    startsAt: '2025-01-01T00:00:00.000Z',
    endsAt: '2026-12-01T00:00:00.000Z',
    daysToEnd: 25,
    noticeDays: 10,
    noticeBy: '2026-11-21T00:00:00.000Z',
    autoRenews: false,
    expired: false,
    annualCost: { amount: 120000, currency: 'SAR' },
    coveredAssets: 384,
    vendor: { id: dell.id, displayName: dell.displayName },
    costCentre: { id: centre.id, displayName: centre.displayName },
    documents: [
      { title: 'Signed agreement', location: 'https://dms.bank.local/contracts/DELL-1.pdf' },
      { title: 'Schedule A', location: '\\\\files\\contracts\\dell-a.pdf' },
    ],
  },
  {
    ci: ci('k2', 'contract', 'Floor lease'),
    kind: 'lease',
    contractNumber: 'LEASE-7',
    title: 'Floor lease',
    level: null,
    responseMinutes: null,
    startsAt: '2020-01-01T00:00:00.000Z',
    endsAt: '2026-01-01T00:00:00.000Z',
    daysToEnd: -309,
    noticeDays: null,
    noticeBy: null,
    autoRenews: false,
    expired: true,
    annualCost: null,
    coveredAssets: 0,
    vendor: null,
    costCentre: null,
    documents: [],
  },
];
const vendors = [
  { ci: dell, category: 'hardware', supportPortal: 'https://support.dell.example', accountManager: 'Lina Saleh', contracts: 1, activeContracts: 1, coveredAssets: 384, annualCost: { amount: 120000, currency: 'SAR' }, contacts: 2 },
];
const contacts = [
  { id: 'c1', name: 'Support desk', role: 'First line', email: 'desk@dell.example', phone: null, portalUrl: null, availability: '24x7', escalationLevel: 1 },
  { id: 'c2', name: 'Duty manager', role: 'Escalation', email: null, phone: '+966 11 000 0000', portalUrl: null, availability: null, escalationLevel: 2 },
];
const centres = [
  { ci: centre, code: 'CC-1000', kind: 'cost_centre', owner: 'Retail Banking', annualBudget: { amount: 19000000, currency: 'SAR' }, contracts: 1, annualContractCost: { amount: 120000, currency: 'SAR' }, assets: 12, plans: 1 },
];

const calls: Array<{ op: string; variables: Record<string, unknown> }> = [];

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? '';
  const variables = body.variables ?? {};
  calls.push({ op, variables });
  switch (op) {
    case 'Contracts': {
      const filter = (variables['filter'] ?? {}) as { kinds?: string[]; expired?: boolean };
      return {
        data: {
          contracts: contracts.filter(
            (c) => (filter.kinds === undefined || filter.kinds.includes(c.kind)) && (filter.expired === undefined || c.expired === filter.expired),
          ),
        },
      };
    }
    case 'Vendors':
      return { data: { vendors } };
    case 'Vendor':
      return { data: { vendor: { vendor: vendors[0], contacts, contracts: contracts.slice(0, 1) } } };
    case 'CostCentres':
      return { data: { costCentres: centres } };
    case 'UpsertContract':
      return { data: { upsertContract: contracts[0] } };
    case 'UpsertVendorContact':
      return { data: { upsertVendorContact: { ...contacts[0], id: 'c3' } } };
    case 'DeleteVendorContact':
      return { data: { deleteVendorContact: true } };
    case 'UpsertCostCentre':
      return { data: { upsertCostCentre: centres[0] } };
    default:
      return { errors: [{ message: 'unexpected operation ' + op }] };
  }
}

beforeEach(() => {
  calls.length = 0;
  roles.current = ['openmap-operator'];
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

function mount(locale: (typeof LOCALES)[number]): void {
  render(
    <Providers locale={locale}>
      <CommercialView locale={locale} />
    </Providers>,
  );
}

const last = (op: string): Record<string, unknown> | undefined => [...calls].reverse().find((c) => c.op === op)?.variables;

describe('commercial helpers', () => {
  it('reads end states, links and the contract and contact inputs', () => {
    expect(endState({ expired: true, daysToEnd: -3 })).toBe('down');
    expect(endState({ expired: false, daysToEnd: 10 })).toBe('at_risk');
    expect(endState({ expired: false, daysToEnd: 200 })).toBe('healthy');
    expect(endState({ expired: false, daysToEnd: null })).toBe('unknown');
    expect(isLink('https://dms.bank.local/x.pdf')).toBe(true);
    expect(isLink('\\\\files\\contracts\\x.pdf')).toBe(false);
    expect(isLink('javascript:alert(1)')).toBe(false);
    const draft = {
      vendorId: 'v1',
      costCentreId: '',
      contractNumber: ' N-1 ',
      kind: 'support' as const,
      title: 'Support',
      level: '',
      responseMinutes: '',
      startsAt: '2026-01-01',
      endsAt: '2026-12-31',
      autoRenews: true,
      noticeDays: '30',
      annualCost: '1000',
      currency: 'sar',
      documents: [{ title: 'SOW', location: ' https://dms/x ' }, { title: '', location: '' }],
    };
    expect(toContractInput(draft)).toMatchObject({ contractNumber: 'N-1', costCentreId: null, level: null, noticeDays: 30, annualCost: 1000, currency: 'SAR', documents: [{ title: 'SOW', location: 'https://dms/x' }] });
    expect(toContractInput({ ...draft, endsAt: '2025-12-31' })).toBeNull();
    expect(toContractInput({ ...draft, currency: '' })).toBeNull();
    expect(toContractInput({ ...draft, vendorId: '' })).toBeNull();
    const contact = { name: 'Desk', role: 'First line', email: '', phone: '', portalUrl: '', availability: '', escalationLevel: '1' };
    expect(toContactInput('v1', contact, null)).toEqual({ vendorId: 'v1', name: 'Desk', role: 'First line', email: null, phone: null, portalUrl: null, availability: null, escalationLevel: 1 });
    expect(toContactInput('v1', { ...contact, escalationLevel: '9' }, null)).toBeNull();
    expect(toContactInput('v1', contact, 'c1')?.id).toBe('c1');
  });
});

describe.each(LOCALES)('CommercialView (%s)', (locale) => {
  it('lists contracts with their dates, cost, coverage and documents, filters them and saves a new one', async () => {
    mount(locale);
    const register = await screen.findByTestId('contract-register');
    const row = register.querySelector('[data-contract-number="DELL-1"]');
    if (!(row instanceof HTMLElement)) throw new Error('contract row missing');
    expect(within(row).getByText(translate(locale, 'commercial.contract.daysLeft', { days: '25' }))).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Signed agreement' }).getAttribute('href')).toBe('https://dms.bank.local/contracts/DELL-1.pdf');
    expect(within(row).queryByRole('link', { name: 'Schedule A' })).toBeNull();
    expect(within(row).getByText('Schedule A')).toBeTruthy();
    const ended = register.querySelector('[data-contract-number="LEASE-7"]');
    if (!(ended instanceof HTMLElement)) throw new Error('lease row missing');
    expect(within(ended).getByText(translate(locale, 'commercial.contract.endedAgo', { days: '309' }))).toBeTruthy();

    fireEvent.change(screen.getByLabelText(translate(locale, 'commercial.contract.kindLabel')), { target: { value: 'lease' } });
    await waitFor(() => {
      expect(last('Contracts')?.['filter']).toEqual({ kinds: ['lease'] });
    });
    fireEvent.change(screen.getByLabelText(translate(locale, 'commercial.filter.endingWithin')), { target: { value: '90' } });
    await waitFor(() => {
      expect(last('Contracts')?.['filter']).toEqual({ kinds: ['lease'], expiringWithinDays: 90 });
    });

    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'commercial.contract.new') }));
    const form = screen.getByRole('form', { name: translate(locale, 'commercial.contract.new') });
    const save = within(form).getByRole('button', { name: translate(locale, 'common.save') });
    expect(save.hasAttribute('disabled')).toBe(true);
    await waitFor(() => {
      expect(within(form).getAllByRole('option', { name: 'Dell Technologies' }).length).toBeGreaterThan(0);
    });
    const fill = (key: Parameters<typeof translate>[1], value: string): void => {
      fireEvent.change(within(form).getByLabelText(translate(locale, key)), { target: { value } });
    };
    fill('commercial.contract.vendor', 'v1');
    fill('commercial.contract.number', 'DELL-9');
    fill('commercial.contract.title', 'Extended warranty');
    fill('commercial.contract.kindLabel', 'warranty_extension');
    fill('commercial.contract.startsAt', '2026-01-01');
    fill('commercial.contract.endsAt', '2028-12-31');
    fill('commercial.contract.annualCost', '45000');
    fill('commercial.contract.currency', 'sar');
    fill('commercial.contract.costCentre', 'cc1');
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'commercial.contract.addDocument') }));
    fireEvent.change(within(form).getByLabelText(translate(locale, 'commercial.contract.documentTitle', { n: '1' })), { target: { value: 'Quote' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'commercial.contract.documentLocation', { n: '1' })), { target: { value: '\\\\files\\quote.pdf' } });
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'commercial.contract.addDocument') }));
    fireEvent.click(save);
    await waitFor(() => {
      expect(last('UpsertContract')).toEqual({
        id: null,
        input: {
          vendorId: 'v1',
          costCentreId: 'cc1',
          contractNumber: 'DELL-9',
          kind: 'warranty_extension',
          title: 'Extended warranty',
          level: null,
          responseMinutes: null,
          startsAt: '2026-01-01',
          endsAt: '2028-12-31',
          autoRenews: false,
          noticeDays: null,
          annualCost: 45000,
          currency: 'SAR',
          documents: [{ title: 'Quote', location: '\\\\files\\quote.pdf' }],
        },
      });
    });
  });

  it('opens a vendor escalation path, adds and removes a contact, and adds a cost centre', async () => {
    mount(locale);
    fireEvent.click(within(screen.getByTestId('commercial-tab-vendors')).getByRole('button'));
    fireEvent.click(await screen.findByRole('button', { name: translate(locale, 'commercial.vendor.open', { name: 'Dell Technologies' }) }));
    const path = await screen.findByTestId('vendor-contacts');
    expect(within(path).getAllByRole('listitem').map((li) => li.textContent.includes('Support desk'))).toEqual([true, false]);
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'commercial.contact.new') }));
    const form = screen.getByRole('form', { name: translate(locale, 'commercial.contact.new') });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'commercial.contact.name')), { target: { value: 'Account director' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'commercial.contact.role')), { target: { value: 'Commercial escalation' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'commercial.contact.level')), { target: { value: '3' } });
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'common.save') }));
    await waitFor(() => {
      expect(last('UpsertVendorContact')?.['input']).toEqual({
        vendorId: 'v1',
        name: 'Account director',
        role: 'Commercial escalation',
        email: null,
        phone: null,
        portalUrl: null,
        availability: null,
        escalationLevel: 3,
      });
    });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'commercial.contact.remove', { name: 'Duty manager' }) }));
    await waitFor(() => {
      expect(last('DeleteVendorContact')).toEqual({ id: 'c2' });
    });

    fireEvent.click(within(screen.getByTestId('commercial-tab-costCentres')).getByRole('button'));
    const centresTable = await screen.findByTestId('cost-centre-register');
    expect(within(centresTable).getByText('CC-1000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'commercial.costCentre.new') }));
    const centreForm = screen.getByRole('form', { name: translate(locale, 'commercial.costCentre.new') });
    fireEvent.change(within(centreForm).getByLabelText(translate(locale, 'commercial.costCentre.code')), { target: { value: 'CC-9000' } });
    fireEvent.change(within(centreForm).getByLabelText(translate(locale, 'commercial.costCentre.name')), { target: { value: 'Payments' } });
    fireEvent.change(within(centreForm).getByLabelText(translate(locale, 'commercial.costCentre.kindLabel')), { target: { value: 'department' } });
    fireEvent.click(within(centreForm).getByRole('button', { name: translate(locale, 'common.save') }));
    await waitFor(() => {
      expect(last('UpsertCostCentre')).toEqual({ id: null, input: { code: 'CC-9000', name: 'Payments', kind: 'department', owner: null, annualBudget: null, currency: null } });
    });
  });
});

describe('CommercialView (analyst)', () => {
  it('reads the register without editing controls', async () => {
    roles.current = ['openmap-analyst'];
    mount('en');
    await screen.findByTestId('contract-register');
    expect(screen.queryByRole('button', { name: translate('en', 'commercial.contract.new') })).toBeNull();
    expect(screen.queryByRole('button', { name: translate('en', 'commercial.contract.edit', { number: 'DELL-1' }) })).toBeNull();
  });
});
