// T-657 REQ-INT-017 (ADR-075) — the Protection screen over stubbed GraphQL, in en and ar:
// - the totals (critical services, supporting CIs, protected, past RPO, unprotected, coverage);
// - the gap rows, unprotected first, each linking to its CI with its state, last good backup, target RPO, age and the
//   services it supports by tier;
// - choosing a tier asks for that tier; a truncated list offers "show all", which asks for the larger page;
// - an empty list says every supporting CI is protected.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BACKUP_AWARENESS, ITSM } from '@openmap/constants';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { ProtectionView } from './ProtectionView';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// jsdom gives the scroll container no height, so the virtualiser would render no row; the test renders them all.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * estimateSize(), size: estimateSize() })),
  }),
}));

const ci = (id: string, type: string, layer: string, displayName: string) => ({
  id,
  name: displayName,
  displayName,
  code: id.toUpperCase(),
  type,
  layer,
  health: 'healthy',
});
const payments = ci('bs-1', 'business_service', 'applications', 'Payments');
const gaps = {
  maxTier: 2,
  criticalServices: 3,
  criticalCis: 40,
  protected: 30,
  rpoBreached: 4,
  unprotected: 6,
  truncated: true,
  items: [
    {
      ci: ci('vm-9', 'vm', 'virtualization', 'vm-ryd-00009'),
      state: 'unprotected',
      lastGoodBackupAt: null,
      policyRpoMinutes: null,
      targetRpoMinutes: 60,
      ageMinutes: null,
      covers: [],
      services: [{ service: payments, tier: 1, rpoMinutes: 60 }],
    },
    {
      ci: ci('host-3', 'host', 'hardware', 'db-ryd-03'),
      state: 'rpo_breached',
      lastGoodBackupAt: '2026-11-08T06:00:00.000Z',
      policyRpoMinutes: 1440,
      targetRpoMinutes: 240,
      ageMinutes: 2880,
      covers: [
        {
          policy: ci('pol-1', 'backup_policy', 'storage', 'Server-Silver'),
          vendor: 'commvault',
          policyKind: 'plan',
          server: null,
          lastGoodBackupAt: '2026-11-08T06:00:00.000Z',
          lastResult: 'failed',
          restorePoints: null,
          rpoMinutes: 1440,
          retentionDays: 14,
          agents: ['File System'],
          via: null,
        },
      ],
      services: [{ service: ci('bs-2', 'business_service', 'applications', 'Cards'), tier: 2, rpoMinutes: 240 }],
    },
  ],
};
const empty = { ...gaps, criticalCis: 12, protected: 12, rpoBreached: 0, unprotected: 0, truncated: false, items: [] };
let response: typeof gaps = gaps;
const calls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  response = gaps;
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        query: string;
        variables?: Record<string, unknown>;
      };
      calls.push(body.variables ?? {});
      const payload = body.query.includes('query ProtectionGaps(')
        ? { data: { protectionGaps: response } }
        : { errors: [{ message: 'unexpected operation' }] };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(locale: (typeof LOCALES)[number]): void {
  render(
    <Providers locale={locale}>
      <ProtectionView locale={locale} />
    </Providers>,
  );
}

describe.each(LOCALES)('ProtectionView (%s)', (locale) => {
  it('shows the totals and the gaps, unprotected first', async () => {
    show(locale);
    const first = await screen.findByRole('link', { name: 'vm-ryd-00009' });
    expect(first.getAttribute('href')).toBe('/' + locale + '/cmdb/vm-9');
    expect(calls[0]).toEqual({ maxTier: BACKUP_AWARENESS.criticalMaxTier, first: BACKUP_AWARENESS.gapRows });
    const kpi = (key: 'protection.kpi.unprotected' | 'protection.kpi.rpoBreached' | 'protection.kpi.cis'): string =>
      screen
        .getAllByText(translate(locale, key))
        .find((e) => e.getAttribute('data-part') === 'label')
        ?.closest('.om-kpi')?.textContent ?? '';
    expect(kpi('protection.kpi.unprotected')).toContain('6');
    expect(kpi('protection.kpi.rpoBreached')).toContain('4');
    expect(kpi('protection.kpi.cis')).toContain('40');
    const rows = [...document.querySelectorAll('[role="row"][data-ci]')];
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['unprotected', 'rpo_breached']);
    const breached = rows[1];
    if (!(breached instanceof HTMLElement)) throw new Error('row missing');
    const r = within(breached);
    expect(r.getByText(translate(locale, 'protection.state.rpo_breached'))).toBeTruthy();
    expect(r.getByText(translate(locale, 'protection.duration.hours', { count: '4' }))).toBeTruthy();
    expect(r.getByText(translate(locale, 'protection.duration.days', { count: '2' }))).toBeTruthy();
    expect(
      r.getByText(translate(locale, 'protection.policyRpo', { rpo: translate(locale, 'protection.duration.days', { count: '1' }) })),
    ).toBeTruthy();
    expect(breached.textContent).toContain('Cards');
    expect(breached.textContent).toContain(translate(locale, 'protection.tier', { tier: '2' }));
    expect(screen.getByText(translate(locale, 'protection.gaps.shown', { shown: '2', total: '10' }))).toBeTruthy();
  });

  it('asks for the chosen tier and for every gap when truncated', async () => {
    show(locale);
    await screen.findByTestId('protection-truncated');
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'protection.gaps.showAll') }));
    await waitFor(() => {
      expect(calls.some((c) => c['first'] === BACKUP_AWARENESS.gapsMaxFirst)).toBe(true);
    });
    fireEvent.click(screen.getByRole('radio', { name: translate(locale, 'protection.tierOrAbove', { tier: String(ITSM.priorityHighest) }) }));
    await waitFor(() => {
      expect(calls.some((c) => c['maxTier'] === ITSM.priorityHighest && c['first'] === BACKUP_AWARENESS.gapRows)).toBe(true);
    });
  });

  it('says every supporting CI is protected when there is no gap', async () => {
    response = empty;
    show(locale);
    expect(await screen.findByTestId('protection-empty')).toBeTruthy();
    expect(screen.queryByTestId('protection-truncated')).toBeNull();
  });
});
