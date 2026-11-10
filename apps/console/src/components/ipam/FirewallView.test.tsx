// T-561 REQ-IPAM-005 (ADR-064) — the IPAM Firewall tab over stubbed GraphQL, in en and ar: a device chosen from the
// list shows its totals, chains with policies, rules in order with zones or interfaces, source, destination, service,
// action, hits and findings (shadowed by a named rule, never hit, any-service allow), a filter to rules with findings,
// and its policy objects with the unused one marked; the traffic check refuses text that is not an address, sends the
// connection (across every firewall, or the chosen one), and lists each device's verdict with the deciding rule and the
// rules it could not tell.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { FirewallCheck, FirewallDevice, FirewallPolicy, FirewallRule } from '@/lib/firewall-queries';
import { FirewallView, chainLabel, findingLabel, specText, verdictState } from './FirewallView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/ipam',
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => children }));

const ci = (id: string, name: string, type: string) => ({ id, name, displayName: name, type });
const HOST = ci('host-1', 'web-01', 'host');
const PA = ci('pa-1', 'pa-01', 'network_device');
const base: Omit<FirewallRule, 'rule' | 'ruleId' | 'name' | 'position' | 'action'> = {
  chain: 'inet filter input',
  hook: 'input',
  target: null,
  sources: [],
  destinations: [],
  services: [],
  fromZone: null,
  toZone: null,
  inInterface: null,
  outInterface: null,
  conditions: [],
  hitCount: null,
  logging: false,
  enabled: true,
  comment: null,
  isPolicy: false,
  findings: [],
};
const rule = (n: number, name: string, extra: Partial<FirewallRule>): FirewallRule => ({
  ...base,
  rule: ci('r' + String(n), name, 'firewall_rule'),
  ruleId: 'inet/filter/input/' + String(n),
  name,
  position: n,
  action: 'allow',
  ...extra,
});
const policy: FirewallPolicy = {
  device: HOST,
  summary: {
    rules: 4,
    allow: 3,
    deny: 1,
    nat: 0,
    objects: 2,
    shadowed: 1,
    unused: 1,
    permissive: 1,
    unusedObjects: 1,
  },
  chains: [
    { name: 'inet filter input', hook: 'input', chainType: 'filter', rules: 4, policy: 'deny' },
    { name: 'inet filter docker_user', hook: null, chainType: null, rules: 0, policy: null },
  ],
  rules: [
    rule(1, 'loopback', { inInterface: 'lo' }),
    rule(2, 'ssh from admin networks', {
      sources: ['@admin_nets'],
      services: ['tcp/22'],
      hitCount: 1_234,
      conditions: ['limit rate 10/second'],
    }),
    rule(3, 'ssh from the jump host', {
      sources: ['10.20.1.5'],
      services: ['tcp/22'],
      hitCount: 0,
      findings: [
        {
          kind: 'shadowed',
          byRuleId: 'inet/filter/input/2',
          byName: 'ssh from admin networks',
          sameAction: true,
        },
        { kind: 'unused', byRuleId: null, byName: null, sameAction: null },
      ],
    }),
    rule(4, 'everything from admin', {
      sources: ['@admin_nets'],
      hitCount: 7,
      findings: [{ kind: 'permissive', byRuleId: null, byName: null, sameAction: null }],
    }),
    rule(5, 'inet filter input policy', { action: 'deny', isPolicy: true }),
  ],
  objects: [
    {
      object: ci('o1', 'admin_nets', 'firewall_object'),
      objectId: 'inet/filter/admin_nets',
      name: 'admin_nets',
      kind: 'address',
      elements: ['10.20.0.0/16', '192.168.0.0/16'],
      comment: 'Jump hosts',
      ruleCount: 2,
      unused: false,
    },
    {
      object: ci('o2', 'legacy', 'firewall_object'),
      objectId: 'inet/filter/legacy',
      name: 'legacy',
      kind: 'address',
      elements: ['10.60.0.0/16'],
      comment: null,
      ruleCount: 0,
      unused: true,
    },
  ],
  truncated: false,
};
const devices: FirewallDevice[] = [
  { device: PA, rules: 12, objects: 9 },
  { device: HOST, rules: 5, objects: 2 },
];
const check: FirewallCheck = {
  evaluated: 2,
  truncated: false,
  results: [
    {
      device: PA,
      chain: '',
      verdict: 'deny',
      rule: { ruleId: '120', name: 'cleanup-deny', position: 12, chain: '', action: 'deny', isPolicy: false },
      path: [''],
      uncertain: [{ ruleId: '10', name: 'trust-to-dmz', position: 1 }],
    },
    {
      device: HOST,
      chain: 'inet filter input',
      verdict: 'allow',
      rule: {
        ruleId: 'inet/filter/input/2',
        name: 'ssh from admin networks',
        position: 2,
        chain: 'inet filter input',
        action: 'allow',
        isPolicy: false,
      },
      path: ['inet filter input'],
      uncertain: [],
    },
  ],
};
const sent: Array<{ query: string; variables: Record<string, unknown> | undefined }> = [];

beforeEach(() => {
  sent.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
        query: string;
        variables?: Record<string, unknown>;
      };
      sent.push({ query: body.query, variables: body.variables });
      const data = body.query.includes('firewallPolicy(')
        ? { firewallPolicy: policy }
        : body.query.includes('firewallCheck(')
          ? { firewallCheck: check }
          : { firewallDevices: devices };
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

describe('firewall helpers', () => {
  it('colours verdicts, words findings and lists, and names the single rule list', () => {
    const t = (key: string, params?: Record<string, string | number>) =>
      translate('en', key as Parameters<typeof translate>[1], params);
    expect(verdictState('allow')).toBe('healthy');
    expect(verdictState('reject')).toBe('down');
    expect(verdictState('no_match')).toBe('unknown');
    expect(findingLabel(t, { kind: 'shadowed', byRuleId: '10', byName: 'web', sameAction: true })).toBe(
      'Shadowed by web',
    );
    expect(findingLabel(t, { kind: 'shadowed', byRuleId: '10', byName: 'web', sameAction: false })).toBe(
      'Overridden by web',
    );
    expect(specText(t, [])).toBe('any');
    expect(specText(t, ['10.0.0.0/8', '@admin'])).toBe('10.0.0.0/8, @admin');
    expect(chainLabel(t, '')).toBe('Rule list');
  });
});

describe.each(LOCALES)('FirewallView (%s)', (locale) => {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key as Parameters<typeof translate>[1], params);
  const show = () =>
    render(
      <Providers locale={locale}>
        <FirewallView locale={locale} />
      </Providers>,
    );

  it("shows a device's rules with findings, its chains and its objects", async () => {
    show();
    const device = screen.getByRole('combobox', { name: t('ipam.fw.device') });
    await waitFor(() => {
      expect(within(device).getAllByRole('option')).toHaveLength(3);
    });
    fireEvent.change(device, { target: { value: 'host-1' } });
    const totals = await screen.findByRole('group', { name: t('ipam.fw.summary', { device: 'web-01' }) });
    expect(within(totals).getByText(t('ipam.fw.kpi.shadowed'))).toBeTruthy();
    expect(sent.find((s) => s.query.includes('firewallPolicy('))?.variables).toEqual({ deviceId: 'host-1' });
    const chains = screen.getByRole('table', { name: t('ipam.fw.chains.title') });
    expect(within(chains).getByText(t('ipam.fw.chain.called'))).toBeTruthy();
    const table = screen.getByRole('table', { name: t('ipam.fw.rules.title', { device: 'web-01' }) });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-findings'))).toEqual([
      '',
      '',
      'shadowed unused',
      'permissive',
      '',
    ]);
    expect(within(rows[0] as HTMLElement).getByText(t('ipam.fw.iface.in', { name: 'lo' }))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('limit rate 10/second')).toBeTruthy();
    expect(
      within(rows[2] as HTMLElement).getByText(
        t('ipam.fw.finding.redundant', { rule: 'ssh from admin networks' }),
      ),
    ).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText(t('ipam.fw.finding.unused'))).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByText(t('ipam.fw.policyRule'))).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getAllByText(t('ipam.fw.any')).length).toBe(3);
    fireEvent.change(screen.getByRole('combobox', { name: t('ipam.fw.rules.show') }), {
      target: { value: 'findings' },
    });
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2);
    const objects = screen.getByRole('table', { name: t('ipam.fw.objects.title') });
    const objectRows = within(objects).getAllByRole('row').slice(1);
    expect(objectRows.map((r) => r.getAttribute('data-unused'))).toEqual(['false', 'true']);
    expect(within(objectRows[1] as HTMLElement).getByText(t('ipam.fw.objects.unused'))).toBeTruthy();
  });

  it('checks a connection across firewalls or on the chosen one, and refuses text that is not an address', async () => {
    show();
    const form = screen.getByRole('form', { name: t('ipam.fw.check.title') });
    const run = within(form).getByRole('button', { name: t('ipam.fw.check.run') });
    fireEvent.change(within(form).getByLabelText(t('ipam.fw.check.source')), {
      target: { value: 'not-an-ip' },
    });
    fireEvent.change(within(form).getByLabelText(t('ipam.fw.check.destination')), {
      target: { value: '10.1.0.20' },
    });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByText(t('ipam.fw.check.invalidAddress'))).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(t('ipam.fw.check.source')), {
      target: { value: '10.20.3.4' },
    });
    fireEvent.change(within(form).getByLabelText(t('ipam.fw.check.port')), { target: { value: '22' } });
    fireEvent.change(within(form).getByLabelText(t('ipam.fw.check.fromZone')), {
      target: { value: 'trust' },
    });
    fireEvent.click(run);
    const results = await screen.findByRole('list', { name: t('ipam.fw.check.results') });
    const items = within(results).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-verdict'))).toEqual(['deny', 'allow']);
    expect(within(items[0] as HTMLElement).getByText(t('ipam.fw.chain.single'))).toBeTruthy();
    expect(
      within(items[0] as HTMLElement).getByText(
        t('ipam.fw.check.uncertain', { count: '1', rules: 'trust-to-dmz' }),
      ),
    ).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText(t('ipam.fw.verdict.allow'))).toBeTruthy();
    expect(sent.find((s) => s.query.includes('firewallCheck('))?.variables).toEqual({
      input: {
        source: '10.20.3.4',
        destination: '10.1.0.20',
        protocol: 'tcp',
        port: 22,
        deviceId: null,
        fromZone: 'trust',
        toZone: null,
      },
    });

    // With a device chosen, the check can be limited to it; ICMP takes no port.
    const device = screen.getByRole('combobox', { name: t('ipam.fw.device') });
    await waitFor(() => {
      expect(within(device).getAllByRole('option')).toHaveLength(3);
    });
    fireEvent.change(device, { target: { value: 'host-1' } });
    const only = await within(form).findByLabelText(t('ipam.fw.check.only', { device: 'web-01' }));
    fireEvent.click(only);
    fireEvent.change(within(form).getByLabelText(t('ipam.fw.check.protocol')), { target: { value: 'icmp' } });
    expect(within(form).getByLabelText<HTMLInputElement>(t('ipam.fw.check.port')).disabled).toBe(true);
    fireEvent.click(run);
    await waitFor(() => {
      expect(sent.filter((s) => s.query.includes('firewallCheck(')).map((s) => s.variables)).toContainEqual({
        input: {
          source: '10.20.3.4',
          destination: '10.1.0.20',
          protocol: 'icmp',
          port: null,
          deviceId: 'host-1',
          fromZone: 'trust',
          toZone: null,
        },
      });
    });
  });
});
