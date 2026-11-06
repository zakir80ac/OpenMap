// T-210 REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — Lifecycle in en and ar: OS releases worst first with end of support, days
// left or ended, extended support and patch currency, a release opened to its CIs, "not in the catalogue" rows; the
// platform tab; hardware by model with end of sale and support; the catalogue sources and the sync shown only when
// allowed; the state filter reaching the query.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { LifecycleView, supportText } from './LifecycleView';
import { createFormatters } from '@/lib/format';
import type * as AuthModule from '@/lib/auth';

const isAdmin = { current: false };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useCan: () => (role: string) => isAdmin.current || role !== 'openmap-admin',
}));

const entry = (endOfSupport: string, extendedSupportEnd: string | null) => ({
  source: 'endoflife.date',
  label: '',
  releaseDate: null,
  supportEnd: null,
  endOfSupport,
  supportEnded: false,
  extendedSupportEnd,
  latest: null,
  lts: true,
  link: null,
});
const releases = [
  {
    key: 'windows-server|2012-r2',
    kind: 'os',
    product: 'windows-server',
    cycle: '2012-r2',
    label: 'Windows Server 2012 R2',
    count: 2,
    versions: ['6.3.9600'],
    entry: entry('2023-10-10', null),
    state: 'ended',
    daysLeft: -1124,
    patchBehind: 1,
    oldestPatchAt: '2025-01-01',
  },
  {
    key: 'unmatched|os|nutanix ahv',
    kind: 'os',
    product: null,
    cycle: null,
    label: 'Nutanix AHV',
    count: 41,
    versions: ['10.0'],
    entry: null,
    state: 'unknown',
    daysLeft: null,
    patchBehind: 0,
    oldestPatchAt: null,
  },
  {
    key: 'ubuntu|24.04',
    kind: 'os',
    product: 'ubuntu',
    cycle: '24.04',
    label: 'Ubuntu 24.04',
    count: 623,
    versions: ['24.04'],
    entry: entry('2029-05-31', '2034-04-25'),
    state: 'supported',
    daysLeft: 936,
    patchBehind: 0,
    oldestPatchAt: null,
  },
  {
    key: 'big-ip|17.1',
    kind: 'network_os',
    product: 'big-ip',
    cycle: '17.1',
    label: 'F5 BIG-IP 17.1',
    count: 6,
    versions: ['17.1.1'],
    entry: entry('2027-03-31', null),
    state: 'ending',
    daysLeft: 144,
    patchBehind: null,
    oldestPatchAt: null,
  },
];
const ci = {
  id: 'os1',
  name: 'win-01',
  displayName: 'win-01',
  code: 'OS-WIN-01',
  type: 'operating_system',
  layer: 'os',
  health: 'healthy',
};
const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
let syncAllowed = false;

function reply(body: { query: string; variables?: Record<string, unknown> }): unknown {
  if (body.query.includes('LifecycleInstances'))
    return { data: { lifecycleReleases: { rows: releases.map((r) => ({ key: r.key, instances: [ci] })) } } };
  if (body.query.includes('LifecycleReleases')) {
    const f = (body.variables?.['filter'] ?? {}) as { kind?: string; state?: string };
    const rows = releases.filter(
      (r) => (f.kind === undefined || r.kind === f.kind) && (f.state === undefined || r.state === f.state),
    );
    return { data: { lifecycleReleases: { rows, supported: 623, ending: 0, ended: 2, unknown: 41 } } };
  }
  if (body.query.includes('LifecycleHardware'))
    return {
      data: {
        lifecycleHardware: [
          {
            key: 'host|Dell|R720',
            ciType: 'host',
            manufacturer: 'Dell Inc.',
            model: 'PowerEdge R720',
            count: 4,
            dated: 1,
            endOfSale: '2018-05-01',
            endOfSupport: '2020-12-31',
            sources: ['manual'],
            state: 'ended',
            daysLeft: -2137,
          },
        ],
      },
    };
  return {
    data: {
      lifecycleCatalogue: {
        url: 'catalogue',
        syncAllowed,
        sources: [
          { source: 'endoflife.date', products: 34, releases: 673, fetchedAt: '2026-11-07T00:30:00.000Z' },
        ],
      },
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  syncAllowed = false;
  isAdmin.current = false;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        query: string;
        variables: Record<string, unknown>;
      };
      calls.push(body);
      return Promise.resolve(
        new Response(JSON.stringify(reply(body)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('supportText', () => {
  it('reads days left, ended ago, or the state', () => {
    const format = createFormatters('en');
    const t = (key: string, v?: Record<string, string>) => translate('en', key as never, v);
    expect(supportText({ state: 'ending', daysLeft: 12 }, t as never, format)).toBe(
      translate('en', 'lifecycle.daysLeft', { days: '12' }),
    );
    expect(supportText({ state: 'ended', daysLeft: -3 }, t as never, format)).toBe(
      translate('en', 'lifecycle.endedAgo', { days: '3' }),
    );
    expect(supportText({ state: 'unknown', daysLeft: null }, t as never, format)).toBe(
      translate('en', 'lifecycle.state.unknown'),
    );
  });
});

describe.each(LOCALES)('LifecycleView (%s)', (locale) => {
  it('lists OS releases, opens one, switches to platforms and hardware, and filters', async () => {
    render(
      <Providers locale={locale}>
        <LifecycleView locale={locale} />
      </Providers>,
    );
    const table = await screen.findByTestId('lifecycle-releases');
    const win = table.querySelector('[data-release="windows-server|2012-r2"]');
    if (!(win instanceof HTMLElement)) throw new Error('windows row missing');
    expect(win.getAttribute('data-state')).toBe('ended');
    expect(within(win).getByText(translate(locale, 'lifecycle.endedAgo', { days: '1,124' }))).toBeTruthy();
    expect(
      within(win).getByText(translate(locale, 'lifecycle.patches.behind', { count: '1', days: '90' })),
    ).toBeTruthy();
    const ahv = table.querySelector('[data-release="unmatched|os|nutanix ahv"]');
    if (!(ahv instanceof HTMLElement)) throw new Error('ahv row missing');
    expect(within(ahv).getByText(translate(locale, 'lifecycle.notInCatalogue'))).toBeTruthy();
    expect(table.querySelector('[data-release="big-ip|17.1"]')).toBeNull();
    fireEvent.click(within(win).getByRole('button', { name: 'Windows Server 2012 R2' }));
    expect(await within(win).findByRole('link', { name: 'win-01' })).toBeTruthy();
    expect(screen.getByText(translate(locale, 'lifecycle.catalogue.syncOff'))).toBeTruthy();

    fireEvent.change(screen.getByLabelText(translate(locale, 'lifecycle.filter.state')), {
      target: { value: 'ended' },
    });
    await waitFor(() => {
      expect(calls.filter((c) => c.query.includes('LifecycleReleases')).at(-1)?.variables).toEqual({
        filter: { kind: 'os', state: 'ended' },
      });
    });

    fireEvent.click(screen.getByRole('tab', { name: translate(locale, 'lifecycle.tab.platforms') }));
    await waitFor(() => {
      expect(
        screen.getByTestId('lifecycle-releases').querySelector('[data-release="big-ip|17.1"]'),
      ).not.toBeNull();
    });
    expect(
      screen.getByTestId('lifecycle-releases').querySelector('[data-release="ubuntu|24.04"]'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: translate(locale, 'lifecycle.tab.hardware') }));
    const hw = await screen.findByTestId('lifecycle-hardware');
    const r720 = hw.querySelector('[data-model="PowerEdge R720"]');
    if (!(r720 instanceof HTMLElement)) throw new Error('hardware row missing');
    expect(r720.getAttribute('data-state')).toBe('ended');
    expect(
      within(r720).getByText(translate(locale, 'lifecycle.hardware.dated', { dated: '1', count: '4' })),
    ).toBeTruthy();
  });

  it('offers the sync to an admin where outbound calls are allowed', async () => {
    syncAllowed = true;
    isAdmin.current = true;
    render(
      <Providers locale={locale}>
        <LifecycleView locale={locale} />
      </Providers>,
    );
    const card = await screen.findByTestId('lifecycle-catalogue');
    fireEvent.click(
      await within(card).findByRole('button', { name: translate(locale, 'lifecycle.catalogue.sync') }),
    );
    await waitFor(() => {
      expect(calls.some((c) => c.query.includes('SyncLifecycle'))).toBe(true);
    });
  });
});
