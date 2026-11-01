// T-102 REQ-UI-010 — IPAM in en and ar: the subnet tree renders by containment with utilisation and collapses,
// selecting a subnet loads its addresses and next free address, the DNS and DHCP tabs list zones, records, scopes and
// leases from the CI queries.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';
import { flattenSubnets, IpamView, utilisationAccent } from './IpamView';

const authValue = (): AuthValue =>
  ({ status: 'signed-in', user: { subject: 's1', username: 'an', displayName: 'Analyst', email: 'a@bank.local', tenant: 'default', roles: ['openmap-analyst'] }, reason: undefined, reasonDetail: undefined, can: () => true, getAccessToken: () => 'tok', signIn: () => Promise.resolve(undefined), completeSignIn: () => Promise.resolve('/'), signOut: () => Promise.resolve(undefined) }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useAuth: () => authValue(), useCan: () => authValue().can }));

const ci = (id: string, name: string, type: string) => ({ id, name, displayName: name, type, layer: 'network_security', health: 'healthy' });
const tree = [
  { ci: ci('s8', '10.0.0.0/8', 'subnet'), cidr: '10.0.0.0/8', vrf: 'global', utilisationPercent: 0, children: [{ ci: ci('s24', '10.0.1.0/24', 'subnet'), cidr: '10.0.1.0/24', vrf: 'global', utilisationPercent: 75.5, children: [] }] },
];
const addresses = [{ ...ci('ip1', '10.0.1.10', 'ip_address'), identity: { address: '10.0.1.10', vrfRef: 'global' }, attributes: { status: 'assigned', interface: 'eth0', macAddress: 'aa:bb' } }];
const zones = [{ ...ci('z1', 'bank.local', 'dns_zone'), identity: { name: 'bank.local' }, attributes: { type: 'primary', server: 'BIND 9', recordCount: 3519, dnssec: false } }];
const records = [{ ...ci('r1', 'www.bank.local', 'dns_record'), identity: { name: 'www.bank.local', recordType: 'A', value: '10.0.1.10', zoneRef: 'bank.local' }, attributes: {} }];
const scopes = [{ ...ci('sc1', 'BR-001', 'dhcp_scope'), identity: { cidr: '10.64.0.0/24', serverRef: 'dhcp-01' }, attributes: { server: 'dhcp-01', rangeStart: '10.64.0.100', rangeEnd: '10.64.0.250', gateway: '10.64.0.1', leaseSeconds: 86400 } }];
const leases = [{ ...ci('l1', '10.64.0.100', 'dhcp_lease'), identity: { address: '10.64.0.100', scopeRef: '10.64.0.0/24' }, attributes: { mac: 'cc:dd', hostname: 'camera-1', expiresAt: '2026-10-23T00:00:00.000Z' } }];
const state = { calls: [] as Array<{ op: string; variables: Record<string, unknown> }> };

function page(nodes: unknown[]) {
  return { edges: nodes.map((node) => ({ cursor: 'c', node })), pageInfo: { endCursor: null, hasNextPage: false }, totalCount: nodes.length };
}

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  state.calls.push({ op, variables: body.variables ?? {} });
  if (op === 'Subnets') return { data: { subnets: tree } };
  if (op === 'NextFreeIp') return { data: { nextFreeIp: '10.0.1.11' } };
  if (op === 'CisByAttribute') {
    const types = (body.variables?.['types'] ?? []) as string[];
    const map: Record<string, unknown[]> = { ip_address: addresses, dns_zone: zones, dns_record: records, dhcp_scope: scopes, dhcp_lease: leases };
    return { data: { cis: page(map[types[0] ?? ''] ?? []) } };
  }
  return { errors: [{ message: 'unexpected operation ' + op }] };
}

beforeEach(() => {
  state.calls = [];
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      return Promise.resolve(new Response(JSON.stringify(respond(JSON.parse(raw) as { query: string; variables?: Record<string, unknown> })), { status: 200, headers: { 'content-type': 'application/json' } }));
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
      <IpamView locale={locale} />
    </Providers>,
  );
}

describe('IpamView helpers', () => {
  it('flattens the tree with depths and colours utilisation by threshold', () => {
    expect(flattenSubnets(tree as never).map((r) => [r.node.cidr, r.depth])).toEqual([['10.0.0.0/8', 0], ['10.0.1.0/24', 1]]);
    expect(utilisationAccent(10)).not.toBe(utilisationAccent(75));
    expect(utilisationAccent(75)).not.toBe(utilisationAccent(95));
  });
});

describe.each(LOCALES)('IpamView (%s)', (locale) => {
  it('renders the tree, collapses a supernet, and shows the selected subnet addresses and next free address', async () => {
    mount(locale);
    await screen.findByText('10.0.1.0/24');
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'ipam.tree.collapse', { cidr: '10.0.0.0/8' }) }));
    expect(screen.queryByText('10.0.1.0/24')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'ipam.tree.expand', { cidr: '10.0.0.0/8' }) }));
    fireEvent.click(await screen.findByRole('button', { name: '10.0.1.0/24' }));
    const panel = screen.getByRole('region', { name: translate(locale, 'ipam.subnet.title') });
    await within(panel).findByText('10.0.1.10');
    await within(panel).findByText('10.0.1.11');
    expect(state.calls.some((c) => c.op === 'CisByAttribute' && JSON.stringify(c.variables['attributeEquals']) === JSON.stringify({ subnet: '10.0.1.0/24' }))).toBe(true);
  });

  it('switches to DNS and DHCP', async () => {
    mount(locale);
    await screen.findByText('10.0.0.0/8');
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'ipam.tab.dns') }));
    await screen.findByText('www.bank.local');
    expect(screen.getByText('bank.local', { selector: 'a' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'ipam.tab.dhcp') }));
    await screen.findByText('camera-1');
    await waitFor(() => {
      expect(screen.getByText('10.64.0.100', { selector: 'a' })).toBeTruthy();
    });
  });
});
