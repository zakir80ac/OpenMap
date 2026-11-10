// T-603 REQ-SEC-012 (ADR-070) — the Assets screen's compliance posture tab in en and ar: before the first evaluation
// it says so (operators and auditors get "Evaluate now", analysts only read); after one it shows the CVE risk, a card
// per framework with the audit pass rate and high-risk CIs from `compliancePosture`, the selected framework's
// controls, and a control's findings from `complianceControl` with the reason, the facts and the high-risk flag; the
// tab is reached from the Assets screen through the URL.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
import type { AuthValue } from '@/lib/auth';
import { Providers } from '@/providers';

const navigation = { search: new URLSearchParams('tab=posture'), replace: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navigation.replace, push: vi.fn() }),
  usePathname: () => '/en/assets',
  useSearchParams: () => navigation.search,
}));
import { CompliancePosture, passRateState } from './CompliancePosture';
import { AssetsView, tabOf } from './AssetsView';

const roles = { current: ['openmap-operator'] as string[] };
const authValue = (): AuthValue =>
  ({
    status: 'signed-in',
    user: { subject: 's1', username: 'op', displayName: 'Omar Operator', email: 'omar@bank.local', tenant: 'default', roles: roles.current },
    reason: undefined,
    reasonDetail: undefined,
    can: (role: string) => roles.current.includes(role) || (role === 'openmap-analyst' && roles.current.length > 0),
    getAccessToken: () => 'tok',
    signIn: () => Promise.resolve(undefined),
    completeSignIn: () => Promise.resolve('/'),
    signOut: () => Promise.resolve(undefined),
  }) as unknown as AuthValue;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useAuth: () => authValue(),
  useCan: () => authValue().can,
}));

const tally = (passed: number, failed: number, notApplicable: number) => ({ passed, failed, notApplicable });
const framework = (id: string, passRate: number | null, highRiskCis: number) => ({
  framework: id,
  edition: 'edition of ' + id,
  passRate,
  evaluations: tally(6, 2, 1),
  controlsPassed: 1,
  controlsFailed: 1,
  controlsNotApplicable: 0,
  controls: [
    { controlId: 'A.8.8', checks: ['cve_high_critical', 'os_patched'], result: 'fail', tally: tally(3, 2, 0) },
    { controlId: 'A.8.20', checks: ['firewall_no_permissive'], result: 'pass', tally: tally(3, 0, 1) },
  ],
  highRiskCis,
});
const evaluated = {
  run: { id: 'run-1', catalogueVersion: '2026.11.1', startedAt: '2026-11-10T09:00:00.000Z', finishedAt: '2026-11-10T09:00:02.000Z', durationMs: 2400, triggeredBy: 'auditor-amal' },
  frameworks: [framework('soc2', 0.75, 1), framework('iso27001', 0.97, 2), framework('pci_dss', 0.5, 1), framework('sama_csf', null, 0), framework('nca_ecc', 0.85, 1)],
  cveRisk: { critical: 3, high: 5, exploited: 1, exposedCis: 4 },
};
const findings = [
  {
    check: 'cve_high_critical',
    result: 'fail',
    reason: 'high_cve',
    highRisk: true,
    ci: { id: 'ci-host-1', name: 'srv-01', displayName: 'srv-01.bank.local', code: 'HW-1', type: 'host', layer: 'hardware', health: 'healthy' },
    facts: [
      { key: 'worstCve', value: 'CVE-2099-0001' },
      { key: 'worstCvss', value: '9.8' },
    ],
  },
  { check: 'os_patched', result: 'fail', reason: 'patch_stale', highRisk: false, ci: null, facts: [{ key: 'lastPatchedAt', value: '2026-01-02' }] },
];

const state = { posture: { run: null, frameworks: [], cveRisk: null } as unknown, evaluations: 0, controlQueries: [] as Array<Record<string, unknown>> };

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  if (body.query.includes('mutation EvaluateCompliance')) {
    state.evaluations += 1;
    state.posture = evaluated;
    return { data: { evaluateCompliance: evaluated } };
  }
  if (body.query.includes('query CompliancePosture')) return { data: { compliancePosture: state.posture } };
  if (body.query.includes('query ComplianceControl')) {
    state.controlQueries.push(body.variables ?? {});
    const failing = body.variables?.['result'] === 'fail';
    return { data: { complianceControl: { framework: body.variables?.['framework'], controlId: body.variables?.['controlId'], checks: ['cve_high_critical', 'os_patched'], result: 'fail', tally: tally(3, 2, 0), findings: failing ? findings : [], truncated: false } } };
  }
  return { data: {} };
}

beforeEach(() => {
  roles.current = ['openmap-operator'];
  state.posture = { run: null, frameworks: [], cveRisk: null };
  state.evaluations = 0;
  state.controlQueries = [];
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

describe('compliance posture helpers', () => {
  it('tones a pass rate and reads the tab from the URL', () => {
    expect(passRateState(null)).toBe('unknown');
    expect(passRateState(0.99)).toBe('healthy');
    expect(passRateState(0.85)).toBe('at_risk');
    expect(passRateState(0.4)).toBe('down');
    expect(tabOf('posture')).toBe('posture');
    expect(tabOf(null)).toBe('register');
    expect(tabOf('anything')).toBe('register');
  });
});

describe.each(LOCALES)('CompliancePosture (%s)', (locale) => {
  const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string>) => translate(locale, key, params);

  it('evaluates, then shows each framework, its controls and a control’s findings', async () => {
    render(
      <Providers locale={locale}>
        <CompliancePosture locale={locale} />
      </Providers>,
    );
    expect(await screen.findByText(tr('assets.compliance.never'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: tr('assets.compliance.evaluate') }));
    await waitFor(() => {
      expect(screen.getAllByTestId('compliance-framework')).toHaveLength(5);
    });
    expect(state.evaluations).toBe(1);
    expect(screen.getByTestId('compliance-last-run').textContent).toContain('auditor-amal');
    expect(screen.getByText(tr('assets.compliance.kpi.critical'))).toBeTruthy();

    const cards = screen.getAllByTestId('compliance-framework');
    const iso = cards.find((c) => c.getAttribute('data-framework') === 'iso27001');
    if (iso === undefined) throw new Error('ISO card');
    expect(iso.getAttribute('data-state')).toBe('healthy');
    expect(within(iso).getByTestId('compliance-high-risk').textContent).toBe(new Intl.NumberFormat(locale).format(2));
    const sama = cards.find((c) => c.getAttribute('data-framework') === 'sama_csf');
    expect(sama?.textContent).toContain(tr('assets.compliance.noPassRate'));

    fireEvent.click(iso);
    const controls = await screen.findByTestId('compliance-controls');
    expect(controls.getAttribute('data-framework')).toBe('iso27001');
    expect(within(controls).getByText(tr('assets.compliance.control.iso27001.A.8.8'))).toBeTruthy();
    expect(within(controls).getAllByText(tr('assets.compliance.check.cve_high_critical')).length).toBeGreaterThan(0);

    fireEvent.click(within(controls).getByRole('button', { name: tr('assets.compliance.table.open', { control: 'A.8.8' }) }));
    const panel = await screen.findByTestId('compliance-findings');
    await waitFor(() => {
      expect(within(panel).getAllByTestId('compliance-finding')).toHaveLength(2);
    });
    expect(state.controlQueries[0]).toMatchObject({ framework: 'iso27001', controlId: 'A.8.8', result: 'fail' });
    const [first, second] = within(panel).getAllByTestId('compliance-finding');
    expect(first?.getAttribute('data-high-risk')).toBe('true');
    expect(within(first as HTMLElement).getByText(tr('assets.compliance.findings.highRisk'))).toBeTruthy();
    expect(within(first as HTMLElement).getByText(tr('assets.compliance.reason.high_cve'))).toBeTruthy();
    expect(first?.textContent).toContain(tr('assets.compliance.fact.worstCve'));
    expect(first?.textContent).toContain('CVE-2099-0001');
    expect(within(second as HTMLElement).getByText(tr('assets.compliance.findings.deployment'))).toBeTruthy();

    fireEvent.change(within(panel).getByTestId('compliance-result-filter'), { target: { value: 'pass' } });
    expect(await within(panel).findByText(tr('assets.compliance.findings.empty'))).toBeTruthy();
  });

  it('lets analysts read the posture without offering an evaluation', async () => {
    roles.current = ['openmap-analyst'];
    render(
      <Providers locale={locale}>
        <CompliancePosture locale={locale} />
      </Providers>,
    );
    expect(await screen.findByText(tr('assets.compliance.neverReadOnly'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: tr('assets.compliance.evaluate') })).toBeNull();
  });

  it('is the Assets screen’s posture tab', async () => {
    state.posture = evaluated;
    render(
      <Providers locale={locale}>
        <AssetsView locale={locale} />
      </Providers>,
    );
    const tab = screen.getByRole('tab', { name: tr('assets.tab.posture') });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByTestId('compliance-posture')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: tr('assets.tab.register') }));
    expect(navigation.replace).toHaveBeenCalledWith('/en/assets', { scroll: false });
  });
});
