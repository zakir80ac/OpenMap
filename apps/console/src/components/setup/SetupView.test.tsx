// T-116 REQ-UI-020 REQ-UI-024 — SetupView renders the six-step wizard over stubbed GraphQL in en and ar: the stepper
// marks completed steps, the organization form saves through updateOrganization, a site is added through upsertSite
// and appears in the table, a Node registration shows its one-time token and enrol command, a credential set is
// stored with its fields only, and generating the twin shows the first sweep.
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
import { SetupView } from './SetupView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/setup',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const organization = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'OpenMap',
  industry: 'unspecified',
  timeZone: 'UTC',
  defaultLocale: 'en',
  regulatoryScope: [],
  airGapped: false,
  businessUnits: [{ tenantId: '22222222-2222-4222-8222-222222222222', name: 'Default', slug: 'default' }],
  createdAt: '2026-11-01T00:00:00.000Z',
};

const site = {
  id: '33333333-3333-4333-8333-333333333333',
  code: 'RYD',
  name: 'Riyadh DC',
  kind: 'datacenter',
  tier: 3,
  address: '',
  city: 'Riyadh',
  countryCode: 'SA',
  geo: null,
  cloud: null,
  locationCount: 1,
  facility: { powerCapacityKw: 800, rackCount: 40, designPue: 1.4 },
  ci: { id: '44444444-4444-4444-8444-444444444444', code: 'FAC-RIYADH-DC', displayName: 'Riyadh DC', layer: 'dc' },
  nodes: [],
};

const node = { id: 'node-ryd-01', status: 'pending', lastHeartbeat: '2026-11-01T00:00:00.000Z', activeJobs: 0, certificateExpiresAt: '2026-11-01T00:00:00.000Z', site: { id: site.ci.id, displayName: site.name } };

interface State {
  organization: typeof organization;
  step: string;
  completedSteps: string[];
  generatedAt: string | null;
  schedulerUrl: string;
  sites: Array<typeof site>;
  links: unknown[];
  nodes: Array<typeof node>;
  credentials: Array<{ ref: string; type: string; fields: string[] }>;
  scopes: unknown[];
  integrations: unknown[];
  firstSweep: { id: string; startedAt: string; finishedAt: string | null; targetsTotal: number; targetsDone: number; devicesDiscovered: number; budgetMinutes: number } | null;
}

let state: State;
const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  calls.push({ query: body.query, variables: body.variables ?? {} });
  const vars = body.variables ?? {};
  if (body.query.includes('query Onboarding')) return { data: { onboarding: state } };
  if (body.query.includes('mutation UpdateOrganization')) {
    const input = vars['input'] as { name: string; businessUnits: Array<{ tenantId: string | null; name: string }> };
    state = { ...state, completedSteps: [...state.completedSteps, 'organization'], organization: { ...state.organization, name: input.name, businessUnits: input.businessUnits.map((u, i) => ({ tenantId: u.tenantId ?? 'new-' + String(i), name: u.name, slug: u.name.toLowerCase() })) } };
    return { data: { updateOrganization: state.organization } };
  }
  if (body.query.includes('mutation UpsertSite')) {
    const input = vars['input'] as { code: string; name: string; kind: string; city: string; countryCode: string };
    const created = { ...site, id: '55555555-5555-4555-8555-555555555555', code: input.code, name: input.name, kind: input.kind, city: input.city, countryCode: input.countryCode, ci: { ...site.ci, code: 'FAC-' + input.code } };
    state = { ...state, sites: [...state.sites, created] };
    return { data: { upsertSite: created } };
  }
  if (body.query.includes('mutation RegisterNode')) {
    state = { ...state, nodes: [...state.nodes, node] };
    return { data: { registerNode: { node, siteCode: 'RYD', enrolToken: 'a'.repeat(64), schedulerUrl: state.schedulerUrl } } };
  }
  if (body.query.includes('mutation SaveCredentialSet')) {
    const input = vars['input'] as { ref: string; type: string; fields: Record<string, string> };
    const saved = { ref: input.ref, type: input.type, fields: Object.keys(input.fields) };
    state = { ...state, credentials: [...state.credentials, saved] };
    return { data: { saveCredentialSet: saved } };
  }
  if (body.query.includes('mutation SetOnboardingStep')) {
    const step = vars['step'] as string;
    state = { ...state, step, completedSteps: state.completedSteps.includes(step) ? state.completedSteps : [...state.completedSteps, step] };
    return { data: { setOnboardingStep: state } };
  }
  if (body.query.includes('mutation GenerateTwin')) {
    state = { ...state, generatedAt: '2026-11-04T10:00:00.000Z', completedSteps: ['organization', 'sites', 'connectivity', 'nodes_credentials', 'integrations', 'generate'], firstSweep: { id: '66666666-6666-4666-8666-666666666666', startedAt: '2026-11-04T10:00:00.000Z', finishedAt: null, targetsTotal: 254, targetsDone: 0, devicesDiscovered: 0, budgetMinutes: 15 } };
    return { data: { generateTwin: state } };
  }
  return { errors: [{ message: 'unexpected operation' }] };
}

beforeEach(() => {
  state = { organization, step: 'organization', completedSteps: [], generatedAt: null, schedulerUrl: 'https://scheduler.test:4200', sites: [], links: [], nodes: [], credentials: [], scopes: [], integrations: [], firstSweep: null };
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

describe.each(LOCALES)('SetupView in %s', (locale) => {
  it('walks the wizard: organization, site, Node token, credential set and the generated twin', async () => {
    render(
      <Providers locale={locale}>
        <SetupView locale={locale} />
      </Providers>,
    );
    const steps = await screen.findByRole('list', { name: translate(locale, 'setup.steps.label') });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(6);

    // Step 1: rename the organization and add a business unit.
    const orgForm = await screen.findByRole('form', { name: translate(locale, 'setup.org.title') });
    fireEvent.change(within(orgForm).getByLabelText(translate(locale, 'setup.org.name')), { target: { value: 'Horizon Bank' } });
    fireEvent.click(within(orgForm).getByRole('button', { name: translate(locale, 'setup.org.unit.add') }));
    const unitInputs = within(orgForm).getAllByLabelText(translate(locale, 'setup.org.unit.name'));
    fireEvent.change(unitInputs[unitInputs.length - 1] as HTMLInputElement, { target: { value: 'Retail Banking' } });
    fireEvent.submit(orgForm);
    await screen.findByRole('status');
    const orgCall = calls.find((c) => c.query.includes('mutation UpdateOrganization'));
    expect((orgCall?.variables['input'] as { name: string; businessUnits: unknown[] }).name).toBe('Horizon Bank');
    expect((orgCall?.variables['input'] as { businessUnits: Array<{ tenantId: string | null; name: string }> }).businessUnits).toEqual([
      { tenantId: '22222222-2222-4222-8222-222222222222', name: 'Default' },
      { tenantId: null, name: 'Retail Banking' },
    ]);

    // Continue to sites: the step is marked complete and the sites form opens because there is none.
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'setup.next') }));
    const siteForm = await screen.findByRole('form', { name: translate(locale, 'setup.sites.form.title') });
    fireEvent.change(within(siteForm).getByLabelText(translate(locale, 'setup.sites.code')), { target: { value: 'ryd' } });
    fireEvent.change(within(siteForm).getByLabelText(translate(locale, 'setup.sites.name')), { target: { value: 'Riyadh DC' } });
    fireEvent.change(within(siteForm).getByLabelText(translate(locale, 'setup.sites.city')), { target: { value: 'Riyadh' } });
    fireEvent.change(within(siteForm).getByLabelText(translate(locale, 'setup.sites.country')), { target: { value: 'sa' } });
    fireEvent.submit(siteForm);
    const table = await screen.findByRole('table', { name: translate(locale, 'setup.sites.title') });
    expect(within(table).getByText('RYD')).toBeTruthy();
    expect(within(table).getByText('FAC-RYD')).toBeTruthy();
    const siteCall = calls.find((c) => c.query.includes('mutation UpsertSite'));
    expect(siteCall?.variables['input']).toMatchObject({ code: 'RYD', countryCode: 'SA', kind: 'datacenter', cloud: null });

    // Skip connectivity, register a Node and store a credential set.
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'setup.next') }));
    await screen.findByRole('heading', { level: 2, name: translate(locale, 'setup.links.title') });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'setup.next') }));
    const nodeForm = await screen.findByRole('form', { name: translate(locale, 'setup.nodes.register') });
    fireEvent.change(within(nodeForm).getByLabelText(translate(locale, 'setup.nodes.nodeId')), { target: { value: 'Node-RYD-01' } });
    fireEvent.submit(nodeForm);
    const token = await screen.findByTestId('enrol-token');
    expect(token.textContent).toBe('a'.repeat(64));
    expect(screen.getByText(/OPENMAP_ENROL_TOKEN=a{64} OPENMAP_SCHEDULER_URL=https:\/\/scheduler\.test:4200 OPENMAP_NODE_ID=node-ryd-01 OPENMAP_SITE_CODE=RYD openmap-node enrol/)).toBeTruthy();

    const credentialForm = screen.getByRole('form', { name: translate(locale, 'setup.credentials.save') });
    fireEvent.change(within(credentialForm).getByLabelText(translate(locale, 'setup.credentials.ref')), { target: { value: 'snmp/core' } });
    fireEvent.change(within(credentialForm).getByLabelText(translate(locale, 'setup.credentials.type')), { target: { value: 'snmp_v2c' } });
    fireEvent.change(within(credentialForm).getByLabelText(translate(locale, 'setup.credentials.field.community')), { target: { value: 'public' } });
    fireEvent.submit(credentialForm);
    await waitFor(() => {
      expect(within(screen.getByRole('region', { name: translate(locale, 'setup.credentials.title') })).getByText('snmp/core')).toBeTruthy();
    });
    const credentialCall = calls.find((c) => c.query.includes('mutation SaveCredentialSet'));
    expect(credentialCall?.variables['input']).toEqual({ ref: 'snmp/core', type: 'snmp_v2c', fields: { community: 'public' } });

    // Generate: skip integrations, run, see the first sweep.
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'setup.next') }));
    await screen.findByRole('heading', { level: 2, name: translate(locale, 'setup.integrations.title') });
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'setup.integrations.skip') }));
    const run = await screen.findByRole('button', { name: translate(locale, 'setup.generate.run') });
    fireEvent.click(run);
    await screen.findByRole('region', { name: translate(locale, 'setup.generate.sweep') });
    expect(screen.getByText(translate(locale, 'setup.generate.sweepRunning'))).toBeTruthy();
    expect(calls.some((c) => c.query.includes('mutation GenerateTwin'))).toBe(true);
  });
});
