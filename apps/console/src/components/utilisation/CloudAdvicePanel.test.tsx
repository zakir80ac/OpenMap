// T-509 REQ-AI-005 — the cloud recommendations panel over stubbed GraphQL, in en and ar: each advised resource with
// its advice, saving, cost, load and owner, and the total saving; an estate with nothing to advise says so.
import { cleanup, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { CloudAdvicePanel } from './CloudAdvicePanel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/en/utilisation' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const ci = (id: string, displayName: string) => ({ id, name: id, displayName, code: id.toUpperCase(), type: 'cloud_resource', layer: 'cloud', health: 'unknown' });
let advice: unknown;

beforeEach(() => {
  advice = {
    resources: 12,
    monthlySavingUsd: 1552.51,
    asOf: '2026-11-08T08:00:00.000Z',
    items: [
      { ci: ci('vm1', 'vm-idle'), kind: 'decommission_idle', savingUsd: 1200, averageLoad: 2, peakLoad: 3, samples: 3, loadAt: '2026-11-08T07:00:00.000Z', sku: 'm6i.xlarge', state: 'running', monthlyCostUsd: 1200, owner: 'payments', environment: 'prod' },
      { ci: ci('db1', 'db-stopped'), kind: 'release_stopped', savingUsd: 352.51, averageLoad: null, peakLoad: null, samples: 0, loadAt: null, sku: 'm6i.xlarge', state: 'stopped', monthlyCostUsd: 352.51, owner: 'data-platform', environment: 'dev' },
      { ci: ci('vm2', 'vm-hot'), kind: 'upsize', savingUsd: 0, averageLoad: 90.5, peakLoad: 93, samples: 2, loadAt: null, sku: 'm6i.large', state: 'running', monthlyCostUsd: 600, owner: null, environment: null },
    ],
  };
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: { cloudAdvice: advice } }), { status: 200, headers: { 'content-type': 'application/json' } }))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('CloudAdvicePanel in %s', (locale) => {
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const render_ = () =>
    render(
      <Providers locale={locale}>
        <CloudAdvicePanel locale={locale} />
      </Providers>,
    );

  it('lists each recommendation with the figures behind it and the total saving', async () => {
    render_();
    const table = await screen.findByRole('table', { name: translate(locale, 'cloudAdvice.table') });
    const idle = within(table).getByRole('link', { name: 'vm-idle' }).closest('tr');
    if (idle === null) throw new Error('no idle row');
    expect(within(idle).getByText(translate(locale, 'cloudAdvice.kind.decommission_idle'))).toBeTruthy();
    expect(within(idle).getAllByText(translate(locale, 'cloudAdvice.usd', { value: n(1200) }))).toHaveLength(2);
    expect(within(idle).getByText(translate(locale, 'cloudAdvice.load', { average: translate(locale, 'cloudAdvice.percent', { value: n(2) }), peak: translate(locale, 'cloudAdvice.percent', { value: n(3) }) }))).toBeTruthy();
    expect(within(idle).getByText('payments')).toBeTruthy();
    const hot = within(table).getByRole('link', { name: 'vm-hot' }).closest('tr');
    if (hot === null) throw new Error('no hot row');
    expect(within(hot).getByText(translate(locale, 'cloudAdvice.kind.upsize'))).toBeTruthy();
    const summary = screen.getByRole('group', { name: translate(locale, 'cloudAdvice.summary') });
    expect(within(summary).getByText(translate(locale, 'cloudAdvice.usd', { value: n(1552.51) }))).toBeTruthy();
    expect(within(summary).getByText(n(12))).toBeTruthy();
  });

  it('says so when nothing needs advice', async () => {
    advice = { resources: 4, monthlySavingUsd: 0, asOf: '2026-11-08T08:00:00.000Z', items: [] };
    render_();
    expect(await screen.findByText(translate(locale, 'cloudAdvice.empty'))).toBeTruthy();
  });
});
