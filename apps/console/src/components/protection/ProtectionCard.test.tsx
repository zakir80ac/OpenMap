// T-657 REQ-INT-017 (ADR-075) — the CI detail's Protection card over stubbed GraphQL, in en and ar:
// - a VM past its RPO: the state badge, the last good backup with its age, the target RPO beside the policy RPO, each
//   covering policy (vendor, kind, server, last result, restore points, retention) linking to the policy CI, and the
//   business services it supports with tier and required RPO;
// - a database whose cover is inherited from its host through a Commvault SQL Server agent ("inherited from");
// - an unprotected host with no cover and no service;
// - a type no backup protects (the API answers null): no card at all.
import { cleanup, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { ProtectionCard } from './ProtectionCard';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
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

const policy = ci('pol-veeam', 'backup_policy', 'storage', 'VBR-RYD-Tier1');
const breached = {
  ci: ci('vm-1', 'vm', 'virtualization', 'vm-ryd-00001'),
  state: 'rpo_breached',
  lastGoodBackupAt: '2026-11-09T06:00:00.000Z',
  policyRpoMinutes: 240,
  targetRpoMinutes: 60,
  ageMinutes: 1500,
  covers: [
    {
      policy,
      vendor: 'veeam',
      policyKind: 'job',
      server: 'vbr-ryd-01.bank.example',
      lastGoodBackupAt: '2026-11-09T06:00:00.000Z',
      lastResult: 'warning',
      restorePoints: 14,
      rpoMinutes: 240,
      retentionDays: 30,
      agents: [],
      via: null,
    },
  ],
  services: [{ service: ci('bs-1', 'business_service', 'applications', 'Payments'), tier: 1, rpoMinutes: 60 }],
};
const inherited = {
  ci: ci('db-1', 'database', 'databases', 'core-ledger'),
  state: 'protected',
  lastGoodBackupAt: '2026-11-10T05:00:00.000Z',
  policyRpoMinutes: 60,
  targetRpoMinutes: 60,
  ageMinutes: 30,
  covers: [
    {
      policy: ci('pol-cv', 'backup_policy', 'storage', 'Database-Gold'),
      vendor: 'commvault',
      policyKind: 'plan',
      server: null,
      lastGoodBackupAt: '2026-11-10T05:00:00.000Z',
      lastResult: 'success',
      restorePoints: null,
      rpoMinutes: 60,
      retentionDays: null,
      agents: ['SQL Server', 'File System'],
      via: ci('host-db', 'host', 'hardware', 'db-ryd-01'),
    },
  ],
  services: [],
};
const unprotected = {
  ci: ci('host-2', 'host', 'hardware', 'app-ryd-02'),
  state: 'unprotected',
  lastGoodBackupAt: null,
  policyRpoMinutes: null,
  targetRpoMinutes: 1440,
  ageMinutes: null,
  covers: [],
  services: [],
};
const BY_ID: Record<string, unknown> = { 'vm-1': breached, 'db-1': inherited, 'host-2': unprotected, 'sw-1': null };

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        query: string;
        variables?: { ciId?: string };
      };
      const payload = body.query.includes('query CiProtection(')
        ? { data: { ciProtection: BY_ID[body.variables?.ciId ?? ''] ?? null } }
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

function show(locale: (typeof LOCALES)[number], ciId: string): void {
  render(
    <Providers locale={locale}>
      <ProtectionCard locale={locale} ciId={ciId} />
    </Providers>,
  );
}

describe.each(LOCALES)('ProtectionCard (%s)', (locale) => {
  it('shows a VM past its RPO with its policy and services', async () => {
    show(locale, 'vm-1');
    const badge = await screen.findByText(translate(locale, 'protection.state.rpo_breached'));
    const card = badge.closest('[data-testid="protection-card"]');
    if (!(card instanceof HTMLElement)) throw new Error('card missing');
    const c = within(card);
    expect(c.getByText(translate(locale, 'protection.targetRpo', { rpo: translate(locale, 'protection.duration.hours', { count: '1' }) }))).toBeTruthy();
    expect(c.getByText(translate(locale, 'protection.policyRpo', { rpo: translate(locale, 'protection.duration.hours', { count: '4' }) }))).toBeTruthy();
    expect(c.getByText(translate(locale, 'protection.ago', { age: translate(locale, 'protection.duration.days', { count: '1' }) }))).toBeTruthy();
    const cover = card.querySelector('[data-cover="pol-veeam"]');
    if (!(cover instanceof HTMLElement)) throw new Error('cover missing');
    expect(cover.getAttribute('data-vendor')).toBe('veeam');
    expect(within(cover).getByRole('link', { name: 'VBR-RYD-Tier1' }).getAttribute('href')).toBe('/' + locale + '/cmdb/pol-veeam');
    expect(within(cover).getByText(translate(locale, 'protection.vendor.veeam'))).toBeTruthy();
    expect(within(cover).getByText(translate(locale, 'protection.kind.job'))).toBeTruthy();
    expect(within(cover).getByText(translate(locale, 'protection.result.warning'))).toBeTruthy();
    expect(within(cover).getByText('vbr-ryd-01.bank.example')).toBeTruthy();
    expect(within(cover).getByText(translate(locale, 'protection.restorePoints', { count: '14' }))).toBeTruthy();
    expect(within(cover).getByText(translate(locale, 'protection.retention', { days: '30' }))).toBeTruthy();
    const service = card.querySelector('[data-service="bs-1"]');
    if (!(service instanceof HTMLElement)) throw new Error('service missing');
    expect(within(service).getByRole('link', { name: 'Payments' })).toBeTruthy();
    expect(within(service).getByText(translate(locale, 'protection.tier', { tier: '1' }))).toBeTruthy();
    expect(
      within(service).getByText(translate(locale, 'protection.serviceRpo', { rpo: translate(locale, 'protection.duration.hours', { count: '1' }) })),
    ).toBeTruthy();
  });

  it('names the host a database inherits its cover from', async () => {
    show(locale, 'db-1');
    await screen.findByText(translate(locale, 'protection.state.protected'));
    const via = document.querySelector('[data-via="host-db"]');
    if (!(via instanceof HTMLElement)) throw new Error('inherited cover missing');
    expect(via.textContent).toContain(translate(locale, 'protection.viaLabel'));
    expect(within(via).getByRole('link', { name: 'db-ryd-01' }).getAttribute('href')).toBe('/' + locale + '/cmdb/host-db');
    expect(screen.getByText('SQL Server')).toBeTruthy();
    expect(screen.getByText(translate(locale, 'protection.noServices'))).toBeTruthy();
  });

  it('shows an unprotected host without covers', async () => {
    show(locale, 'host-2');
    await screen.findByText(translate(locale, 'protection.state.unprotected'));
    expect(screen.getByText(translate(locale, 'protection.noCovers'))).toBeTruthy();
    expect(screen.getByTestId('protection-last-good').textContent).toBe(translate(locale, 'protection.neverBackedUp'));
  });

  it('renders nothing for a type no backup protects', async () => {
    show(locale, 'sw-1');
    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(screen.queryByTestId('protection-card')).toBeNull();
    });
  });
});
