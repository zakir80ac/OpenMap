// T-109 REQ-UI-015 REQ-CMDB-030 REQ-CMDB-031 — Software and licences in en and ar: the catalogue from `software`,
// licence cells with usage and over-deployment, the posture card grouping over-deployed, expiring and expired
// licences, the filter form sending text and licensedOnly, and the helpers that compute posture and utilisation.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { LicenceSummary, SoftwareProduct } from '@/lib/software-queries';
import { SoftwareView, licencePosture, utilisationPercent } from './SoftwareView';

const DAY_MS = 24 * 60 * 60 * 1000;
const soon = new Date(Date.now() + 20 * DAY_MS).toISOString();
const far = new Date(Date.now() + 400 * DAY_MS).toISOString();
const ci = (id: string, name: string, type: string, layer: string) => ({
  id,
  name,
  displayName: name,
  type,
  layer,
  health: 'healthy',
});

const pgLicence: LicenceSummary = {
  ci: ci('lic-pg', 'PostgreSQL licence 01', 'licence', 'applications') as SoftwareProduct['ci'],
  metric: 'cores',
  licenceType: 'subscription',
  entitlement: 32,
  consumed: 40,
  overDeployed: true,
  expiresAt: soon,
  expired: false,
  annualCost: { amount: 120000, currency: 'SAR' },
  contract: null,
};
const oraLicence: LicenceSummary = {
  ci: ci('lic-ora', 'Oracle licence 01', 'licence', 'databases') as SoftwareProduct['ci'],
  metric: 'processors',
  licenceType: 'perpetual',
  entitlement: 8,
  consumed: 4,
  overDeployed: false,
  expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
  expired: true,
  annualCost: null,
  contract: null,
};

const products: SoftwareProduct[] = [
  {
    ci: ci('sw-pg', 'PostgreSQL 16.4', 'software', 'applications') as SoftwareProduct['ci'],
    vendor: 'PostgreSQL Global Development Group',
    name: 'PostgreSQL',
    version: '16.4',
    category: 'database',
    endOfSupport: far,
    instances: 12,
    hosts: 9,
    running: 11,
    licence: pgLicence,
    vulnerabilities: 3,
  },
  {
    ci: ci('sw-nginx', 'nginx 1.26', 'software', 'applications') as SoftwareProduct['ci'],
    vendor: 'F5',
    name: 'nginx',
    version: '1.26',
    category: null,
    endOfSupport: null,
    instances: 4,
    hosts: 4,
    running: 4,
    licence: null,
    vulnerabilities: 0,
  },
  {
    ci: ci('sw-ora', 'Oracle Database 19c', 'software', 'databases') as SoftwareProduct['ci'],
    vendor: 'Oracle',
    name: 'Database',
    version: '19c',
    category: 'database',
    endOfSupport: far,
    instances: 2,
    hosts: 2,
    running: 2,
    licence: oraLicence,
    vulnerabilities: 1,
  },
];
const state = { calls: [] as Array<{ op: string; variables: Record<string, unknown> }> };

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  state.calls.push({ op, variables: body.variables ?? {} });
  if (op !== 'Software') return { errors: [{ message: 'unexpected operation ' + op }] };
  const v = body.variables ?? {};
  let list = products;
  if (v['licensedOnly'] === true) list = list.filter((p) => p.licence !== null);
  if (typeof v['text'] === 'string')
    list = list.filter((p) =>
      (p.vendor + ' ' + p.name).toLowerCase().includes((v['text'] as string).toLowerCase()),
    );
  return { data: { software: list } };
}

beforeEach(() => {
  state.calls = [];
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
      <SoftwareView locale={locale} />
    </Providers>,
  );
}

describe('SoftwareView helpers', () => {
  it('groups licences into over-deployed, expiring and expired', () => {
    const posture = licencePosture(products, new Date(), 90);
    expect(posture.overDeployed.map((p) => p.name)).toEqual(['PostgreSQL']);
    expect(posture.expiring.map((p) => p.name)).toEqual(['PostgreSQL']);
    expect(posture.expired.map((p) => p.name)).toEqual(['Database']);
    expect(licencePosture(products, new Date(), 10).expiring).toEqual([]);
  });

  it('computes utilisation as a whole percentage and treats a zero entitlement as fully consumed', () => {
    expect(utilisationPercent(pgLicence)).toBe(125);
    expect(utilisationPercent(oraLicence)).toBe(50);
    expect(utilisationPercent({ ...oraLicence, consumed: 3, entitlement: 0 })).toBe(100);
    expect(utilisationPercent({ ...oraLicence, consumed: 0, entitlement: 0 })).toBe(0);
  });
});

describe.each(LOCALES)('SoftwareView (%s)', (locale) => {
  it('lists the catalogue with licence cells and the posture groups', async () => {
    mount(locale);
    const tables = await screen.findAllByRole('table');
    const table = tables[0] ?? document.body;
    expect(within(table).getAllByRole('row')).toHaveLength(products.length + 1);
    expect(within(table).getByText('PostgreSQL Global Development Group PostgreSQL')).toBeTruthy();
    expect(within(table).getByText(translate(locale, 'software.licence.none'))).toBeTruthy();
    expect(
      within(table).getAllByText(translate(locale, 'software.licence.overDeployed')).length,
    ).toBeGreaterThan(0);
    expect(
      within(table).getByText(translate(locale, 'software.vulnerabilities.open', { count: '3' })),
    ).toBeTruthy();
    const overDeployed = screen.getByRole('region', {
      name: translate(locale, 'software.posture.overDeployed'),
    });
    expect(
      within(overDeployed).getByText('PostgreSQL Global Development Group PostgreSQL 16.4'),
    ).toBeTruthy();
    const expired = screen.getByRole('region', { name: translate(locale, 'software.posture.expired') });
    expect(within(expired).getByText('Oracle Database 19c')).toBeTruthy();
  });

  it('sends the filter text and licensedOnly to the query', async () => {
    mount(locale);
    await screen.findAllByRole('table');
    fireEvent.click(screen.getByLabelText(translate(locale, 'software.filter.licensedOnly')));
    await waitFor(() => {
      expect(state.calls.some((c) => c.op === 'Software' && c.variables['licensedOnly'] === true)).toBe(true);
    });
    fireEvent.change(screen.getByLabelText(translate(locale, 'software.filter.text')), {
      target: { value: 'oracle' },
    });
    fireEvent.submit(screen.getByRole('form', { name: translate(locale, 'software.filter.apply') }));
    await waitFor(() => {
      expect(state.calls.some((c) => c.op === 'Software' && c.variables['text'] === 'oracle')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText('PostgreSQL Global Development Group PostgreSQL')).toBeNull();
    });
  });
});
