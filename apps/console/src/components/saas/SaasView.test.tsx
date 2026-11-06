// T-214 REQ-CMDB-022 — SaaS in en and ar: headline seats, unused, renewing and lapsed counts; each tenant with users and
// SSO applications; subscriptions with seats assigned of bought, underuse, renewal or lapse, and the data flows from the
// organisation's applications.
import { cleanup, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { SaasView } from './SaasView';

const ci = (id: string, type: string, displayName: string) => ({
  id,
  name: displayName,
  displayName,
  code: id.toUpperCase(),
  type,
  layer: 'saas',
  health: 'healthy',
});
const inventory = {
  seatsTotal: 600,
  seatsAssigned: 530,
  unusedSeats: 70,
  renewing: 1,
  lapsed: 1,
  dataFlows: 1,
  tenants: [
    {
      ci: ci('t1', 'saas_tenant', 'Salesforce Enterprise'),
      vendor: 'Salesforce',
      edition: 'Enterprise',
      users: 500,
      activeUsers: 410,
      ssoApplications: 33,
      domains: ['bank.example'],
      subscriptions: [
        {
          ci: ci('s2', 'saas_application', 'Service Cloud'),
          product: 'Service Cloud',
          sku: null,
          status: 'expired',
          seatsTotal: 500,
          seatsAssigned: 490,
          unusedSeats: 10,
          utilisationPercent: 98,
          underused: false,
          subscriptionEnd: '2026-11-02',
          daysToRenewal: -5,
          state: 'lapsed',
          dataFlows: [],
        },
        {
          ci: ci('s1', 'saas_application', 'Sales Cloud'),
          product: 'Sales Cloud',
          sku: 'SFDC-SALES-EE',
          status: 'enabled',
          seatsTotal: 100,
          seatsAssigned: 40,
          unusedSeats: 60,
          utilisationPercent: 40,
          underused: true,
          subscriptionEnd: '2026-12-07',
          daysToRenewal: 30,
          state: 'renewing',
          dataFlows: [
            {
              application: ci('a1', 'application', 'customer-portal'),
              dataClass: 'customer',
              direction: 'outbound',
            },
          ],
        },
      ],
    },
  ],
};

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { saasInventory: inventory } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('SaasView (%s)', (locale) => {
  it('shows tenants, seats, renewals and data flows', async () => {
    render(
      <Providers locale={locale}>
        <SaasView locale={locale} />
      </Providers>,
    );
    const tenant = await screen.findByText('Salesforce · Enterprise');
    const card = tenant.closest('[data-tenant]');
    if (!(card instanceof HTMLElement)) throw new Error('tenant card missing');
    expect(
      within(card).getByText(
        translate(locale, 'saas.tenant.summary', { users: '500', active: '410', sso: '33' }),
      ),
    ).toBeTruthy();
    const sales = card.querySelector('[data-subscription="Sales Cloud"]');
    if (!(sales instanceof HTMLElement)) throw new Error('subscription missing');
    expect(sales.getAttribute('data-state')).toBe('renewing');
    expect(
      within(sales).getByText(
        translate(locale, 'saas.seats', { assigned: '40', total: '100', unused: '60' }),
      ),
    ).toBeTruthy();
    expect(within(sales).getByText(translate(locale, 'saas.underused'))).toBeTruthy();
    expect(within(sales).getByText(translate(locale, 'saas.renewsIn', { days: '30' }))).toBeTruthy();
    expect(within(sales).getByRole('link', { name: 'customer-portal' })).toBeTruthy();
    const service = card.querySelector('[data-subscription="Service Cloud"]');
    if (!(service instanceof HTMLElement)) throw new Error('lapsed subscription missing');
    expect(within(service).getByText(translate(locale, 'saas.lapsedAgo', { days: '5' }))).toBeTruthy();
    // Lapsed first: soonest renewal leads.
    expect(
      [...card.querySelectorAll('tr[data-subscription]')].map((r) => r.getAttribute('data-subscription')),
    ).toEqual(['Service Cloud', 'Sales Cloud']);
  });
});
