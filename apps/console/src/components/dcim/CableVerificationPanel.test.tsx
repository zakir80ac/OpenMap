// T-552 REQ-DCIM-008 (ADR-062) — the cable verification panel over stubbed GraphQL, in en and ar: the five totals, the
// recorded cables with their verdict (mismatch first, naming what was seen instead), the undocumented links with their
// suggested label, an operator starting a cable from one, a viewer without that action, and the labels download.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { CableVerification, CablingVerification, ObservedLink } from '@/lib/cabling-queries';
import { CableVerificationPanel, reasonKey, sortVerdicts, statusKey } from './CableVerificationPanel';

const ci = (id: string, name: string, type = 'network_device') => ({ id, name, type });
const seen: ObservedLink = {
  a: { ci: ci('sw1', 'tor-a'), port: 'Ethernet2' },
  b: { ci: ci('sw3', 'tor-c'), port: 'Ethernet9' },
  protocol: 'lldp',
  media: null,
  speedMbps: 10_000,
  suggestedLabel: 'tor-a:Ethernet2 - tor-c:Ethernet9',
};
const verdict = (
  id: string,
  label: string,
  status: CableVerification['status'],
  reason: CableVerification['reason'],
  observed: ObservedLink | null = null,
): CableVerification => ({ cable: { ci: { id }, label }, status, reason, observed });
const verification: CablingVerification = {
  summary: { cables: 4, verified: 1, mismatch: 1, unobserved: 1, unverifiable: 1, undocumented: 37 },
  cables: [
    verdict('c1', 'C-0001', 'verified', 'observed'),
    verdict('c2', 'C-0002', 'unobserved', 'no_observation'),
    verdict('c3', 'C-0003', 'mismatch', 'far_end_differs', seen),
    verdict('c4', 'C-0004', 'unverifiable', 'path_incomplete'),
  ],
  undocumented: [
    seen,
    {
      a: { ci: ci('srv1', 'esx-01', 'host'), port: 'eno1' },
      b: { ci: ci('sw1', 'tor-a'), port: 'Ethernet7' },
      protocol: 'lldp',
      media: '10GBASE-T',
      speedMbps: null,
      suggestedLabel: 'esx-01:eno1 - tor-a:Ethernet7',
    },
  ],
};
const queries: string[] = [];

beforeEach(() => {
  queries.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { query: string };
      queries.push(body.query);
      const data = body.query.includes('cablingLabelsCsv')
        ? { cablingLabelsCsv: 'label,kind\nC-0001,patch\n' }
        : { cablingVerification: verification };
      return Promise.resolve(
        new Response(JSON.stringify({ data }), {
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

describe('verification helpers', () => {
  it('sorts the verdicts to act on first and maps statuses and reasons to their keys', () => {
    expect(sortVerdicts(verification.cables).map((c) => c.cable.label)).toEqual([
      'C-0003',
      'C-0004',
      'C-0002',
      'C-0001',
    ]);
    expect(statusKey('mismatch')).toBe('dcim.cabling.verify.status.mismatch');
    expect(reasonKey('path_incomplete')).toBe('dcim.cabling.verify.reason.path_incomplete');
  });
});

describe.each(LOCALES)('CableVerificationPanel (%s)', (locale) => {
  it('shows the totals, the verdicts and the undocumented links, and starts a cable from one', async () => {
    const onRecord = vi.fn();
    render(
      <Providers locale={locale}>
        <CableVerificationPanel operator onRecord={onRecord} />
      </Providers>,
    );
    const totals = await screen.findByRole('group', { name: translate(locale, 'dcim.cabling.verify.title') });
    expect(within(totals).getByText(translate(locale, 'dcim.cabling.verify.undocumented'))).toBeTruthy();
    expect(within(totals).getByText('37')).toBeTruthy();
    const cables = screen.getByRole('table', { name: translate(locale, 'dcim.cabling.verify.cables') });
    const rows = within(cables).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual([
      'mismatch',
      'unverifiable',
      'unobserved',
      'verified',
    ]);
    expect(
      within(rows[0] as HTMLElement).getByText(
        translate(locale, 'dcim.cabling.verify.seenInstead', { link: seen.suggestedLabel }),
      ),
    ).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement).getByText(
        translate(locale, 'dcim.cabling.verify.reason.path_incomplete'),
      ),
    ).toBeTruthy();
    const links = screen.getByRole('table', {
      name: translate(locale, 'dcim.cabling.verify.undocumentedTitle'),
    });
    expect(within(links).getByText('esx-01:eno1 - tor-a:Ethernet7')).toBeTruthy();
    expect(
      within(links).getByText(translate(locale, 'dcim.cabling.verify.speedValue', { mbps: '10,000' })),
    ).toBeTruthy();
    fireEvent.click(
      within(links).getByRole('button', {
        name: translate(locale, 'dcim.cabling.verify.recordLink', { label: seen.suggestedLabel }),
      }),
    );
    expect(onRecord).toHaveBeenCalledWith(seen);
  });

  it('downloads the labels and offers no record action to a viewer', async () => {
    render(
      <Providers locale={locale}>
        <CableVerificationPanel operator={false} onRecord={vi.fn()} />
      </Providers>,
    );
    const links = await screen.findByRole('table', {
      name: translate(locale, 'dcim.cabling.verify.undocumentedTitle'),
    });
    expect(within(links).queryByRole('button')).toBeNull();
    // jsdom has no navigation: the download's anchor click is observed rather than followed.
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'dcim.cabling.verify.labels') }));
    await waitFor(() => {
      expect(queries.some((q) => q.includes('cablingLabelsCsv'))).toBe(true);
    });
    click.mockRestore();
  });
});
