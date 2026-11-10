// T-518 REQ-IPAM-003 — the DNS sync panel over stubbed GraphQL, in en and ar: the zones kept in sync with their server
// and pending count, the changes with their state and error, and an operator's change request sent with the zone,
// op, name, type, value and TTL.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { DnsSyncPanel } from './DnsSyncPanel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/en/ipam' }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<object>()), useCan: () => () => true }));

const sync = {
  dnsZoneSyncs: [{ id: 'z1', zone: 'lab.openmap.test', server: 'dns-lab', port: 53, tsigKeyName: 'openmap-sync', credentialRef: 'dns/lab', siteId: 's1', enabled: true, lastPullAt: '2026-11-08T09:00:00.000Z', lastPushAt: null, lastError: null, pending: 1 }],
  dnsChanges: [
    { id: 'c1', zone: 'lab.openmap.test', op: 'add', name: 'api.lab.openmap.test', recordType: 'A', value: '10.77.0.81', ttl: 600, state: 'applied', error: null, requestedBy: 'admin', requestedAt: '2026-11-08T09:00:00.000Z', settledAt: '2026-11-08T09:01:00.000Z' },
    { id: 'c2', zone: 'lab.openmap.test', op: 'delete', name: 'legacy.lab.openmap.test', recordType: 'A', value: '10.77.0.70', ttl: 3600, state: 'failed', error: 'dns-lab refused lab.openmap.test (check the TSIG key)', requestedBy: 'admin', requestedAt: '2026-11-08T09:02:00.000Z', settledAt: null },
  ],
};
const sent: Array<{ query: string; variables: Record<string, unknown> | undefined }> = [];

beforeEach(() => {
  sent.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { query: string; variables?: Record<string, unknown> };
      sent.push({ query: body.query, variables: body.variables });
      const data = body.query.includes('requestDnsChange')
        ? { requestDnsChange: { ...sync.dnsChanges[0], id: 'c3', state: 'pending' } }
        : body.query.includes('onboarding')
          ? { onboarding: { sites: [{ id: 's1', code: 'LOCAL', name: 'Compose host' }], credentials: [{ ref: 'dns/lab', type: 'api_token', fields: ['token'] }] } }
          : sync;
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('DnsSyncPanel in %s', (locale) => {
  it('shows the zones and changes, and sends a change request', async () => {
    render(
      <Providers locale={locale}>
        <DnsSyncPanel />
      </Providers>,
    );
    const zones = await screen.findByRole('table', { name: translate(locale, 'ipam.dnsSync.zones') });
    expect(within(zones).getByText('lab.openmap.test')).toBeTruthy();
    expect(within(zones).getByText('dns-lab:53')).toBeTruthy();
    const changes = screen.getByRole('table', { name: translate(locale, 'ipam.dnsSync.changes') });
    expect(within(changes).getByText(translate(locale, 'ipam.dnsSync.state.applied'))).toBeTruthy();
    expect(within(changes).getByText('dns-lab refused lab.openmap.test (check the TSIG key)')).toBeTruthy();

    const form = screen.getByRole('form', { name: translate(locale, 'ipam.dnsSync.request') });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'ipam.dnsSync.zone')), { target: { value: 'lab.openmap.test' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'ipam.dnsSync.name')), { target: { value: 'db' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'ipam.dnsSync.value')), { target: { value: '10.77.0.90' } });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'ipam.dnsSync.ttl')), { target: { value: '600' } });
    fireEvent.click(within(form).getByRole('button', { name: translate(locale, 'ipam.dnsSync.request') }));
    await waitFor(() => {
      expect(sent.find((s) => s.query.includes('requestDnsChange'))?.variables).toEqual({ input: { zone: 'lab.openmap.test', op: 'add', name: 'db', recordType: 'A', value: '10.77.0.90', ttl: 600 } });
    });
  });
});
