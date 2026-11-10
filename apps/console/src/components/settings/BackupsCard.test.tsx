// T-570 REQ-INT-019 (ADR-066) — the Backups card over stubbed GraphQL, in en and ar: a fresh set with sizes, CIs and
// schema, a failed one with its reason and a running one; stale when the newest complete set is too old; a deployment
// without a backup directory says so.
import { cleanup, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { BackupsCard, type Backups } from './BackupsCard';

const fresh: Backups = {
  configured: true,
  stale: false,
  staleAfterHours: 26,
  lastCompleteAt: '2026-11-10T06:00:00.000Z',
  sets: [
    {
      name: 'openmap-20261110T080000Z',
      status: 'running',
      createdAt: '2026-11-10T08:00:00.000Z',
      completedAt: null,
      postgresBytes: null,
      clickhouseBytes: null,
      migration: null,
      cis: null,
      error: null,
    },
    {
      name: 'openmap-20261110T070000Z',
      status: 'failed',
      createdAt: '2026-11-10T07:00:00.000Z',
      completedAt: '2026-11-10T07:01:00.000Z',
      postgresBytes: null,
      clickhouseBytes: null,
      migration: null,
      cis: null,
      error: 'interrupted or failed; see the backup log',
    },
    {
      name: 'openmap-20261110T060000Z',
      status: 'complete',
      createdAt: '2026-11-10T06:00:00.000Z',
      completedAt: '2026-11-10T06:04:00.000Z',
      postgresBytes: 2_097_152_000,
      clickhouseBytes: 943_718_400,
      migration: '0043_firewall_object_ci_type',
      cis: 32_765,
      error: null,
    },
  ],
};
let reply: Backups = fresh;

beforeEach(() => {
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { backups: reply } }), {
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
  reply = fresh;
});

describe.each(LOCALES)('BackupsCard (%s)', (locale) => {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key as Parameters<typeof translate>[1], params);
  const show = () =>
    render(
      <Providers locale={locale}>
        <BackupsCard />
      </Providers>,
    );

  it('shows fresh backups with every set, its sizes and why one failed', async () => {
    show();
    const freshness = await screen.findByTestId('backup-freshness');
    expect(within(freshness).getByText(t('settings.backups.fresh'))).toBeTruthy();
    const table = screen.getByRole('table', { name: t('settings.backups.title') });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['running', 'failed', 'complete']);
    expect(
      within(rows[1] as HTMLElement).getByText('interrupted or failed; see the backup log'),
    ).toBeTruthy();
    const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    expect(
      within(rows[2] as HTMLElement).getByText(
        t('settings.backups.megabytes', { value: format.format(2_000) }),
      ),
    ).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('0043_firewall_object_ci_type')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText(t('settings.backups.status.complete'))).toBeTruthy();
  });

  it('warns when the newest complete set is too old, and says when the deployment keeps none', async () => {
    reply = { ...fresh, stale: true };
    show();
    expect(await screen.findByText(t('settings.backups.stale', { hours: '26' }))).toBeTruthy();
    cleanup();
    reply = { configured: false, stale: true, staleAfterHours: 26, lastCompleteAt: null, sets: [] };
    show();
    expect(await screen.findByText(t('settings.backups.unconfigured'))).toBeTruthy();
  });
});
