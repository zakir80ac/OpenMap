// T-110 REQ-UI-016 REQ-CMDB-035 REQ-SEC-008 — Vulnerabilities in en and ar: the ranked list from
// `vulnerabilitySummaries`, headline counts, the CVSS / exposure / exploited filters reaching the query, and the
// blast radius panel (software, hosts, services with predicted states, truncation notice) from `vulnerability`.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { VulnerabilityDetail, VulnerabilitySummary } from '@/lib/software-queries';
import { VulnerabilitiesView, exposureFilter, headline, severityState } from './VulnerabilitiesView';

const ci = (id: string, name: string, type: string, layer: string) =>
  ({ id, name, displayName: name, type, layer, health: 'healthy' }) as VulnerabilitySummary['ci'];

const critical: VulnerabilitySummary = {
  ci: ci('v1', 'CVE-2026-0001', 'vulnerability', 'applications'),
  cveId: 'CVE-2026-0001',
  title: 'Remote code execution in the wire protocol',
  severity: 'critical',
  cvss: 9.8,
  exploited: true,
  cisaKev: true,
  patchAvailable: true,
  publishedAt: '2026-03-01T00:00:00.000Z',
  internetFacing: true,
  affectedSoftware: 1,
  affectedHosts: 9,
  fixedIn: '16.5',
};
const summaries: VulnerabilitySummary[] = [
  critical,
  {
    ci: ci('v2', 'CVE-2026-0002', 'vulnerability', 'applications'),
    cveId: 'CVE-2026-0002',
    title: 'Header smuggling',
    severity: 'high',
    cvss: 7.5,
    exploited: false,
    cisaKev: false,
    patchAvailable: false,
    publishedAt: null,
    internetFacing: false,
    affectedSoftware: 1,
    affectedHosts: 4,
    fixedIn: null,
  },
  {
    ci: ci('v3', 'CVE-2025-9999', 'vulnerability', 'applications'),
    cveId: 'CVE-2025-9999',
    title: 'Log injection',
    severity: 'medium',
    cvss: 5.3,
    exploited: false,
    cisaKev: false,
    patchAvailable: true,
    publishedAt: null,
    internetFacing: false,
    affectedSoftware: 2,
    affectedHosts: 2,
    fixedIn: null,
  },
];

const detail: VulnerabilityDetail = {
  summary: critical,
  software: [ci('sw-pg', 'PostgreSQL 16.4', 'software', 'applications')],
  hosts: [
    ci('h1', 'db-ryd-pg-core-01', 'host', 'hardware'),
    ci('h2', 'db-ryd-pg-core-02', 'host', 'hardware'),
  ],
  services: [
    {
      service: ci('svc-ledger', 'Ledger', 'business_service', 'applications'),
      tier: 1,
      predicted: 'down',
      usersAffected: 4200,
      slaBudgetRemainingMinutes: 31,
    },
    {
      service: ci('svc-cards', 'Cards', 'business_service', 'applications'),
      tier: 2,
      predicted: 'at_risk',
      usersAffected: null,
      slaBudgetRemainingMinutes: null,
    },
  ],
  blastRadiusTruncated: true,
};
const state = { calls: [] as Array<{ op: string; variables: Record<string, unknown> }> };

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  state.calls.push({ op, variables: body.variables ?? {} });
  switch (op) {
    case 'VulnerabilitySummaries': {
      const v = body.variables ?? {};
      let list = summaries;
      if (typeof v['minCvss'] === 'number') list = list.filter((s) => s.cvss >= (v['minCvss'] as number));
      if (v['exploitedOnly'] === true) list = list.filter((s) => s.exploited);
      if (typeof v['internetFacing'] === 'boolean')
        list = list.filter((s) => s.internetFacing === v['internetFacing']);
      return { data: { vulnerabilitySummaries: list } };
    }
    case 'Vulnerability':
      return {
        data: {
          vulnerability: (body.variables as { cveId: string }).cveId === detail.summary.cveId ? detail : null,
        },
      };
    default:
      return { errors: [{ message: 'unexpected operation ' + op }] };
  }
}

beforeEach(() => {
  state.calls = [];
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      return Promise.resolve(
        new Response(
          JSON.stringify(respond(JSON.parse(raw) as { query: string; variables?: Record<string, unknown> })),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
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
      <VulnerabilitiesView locale={locale} />
    </Providers>,
  );
}

describe('VulnerabilitiesView helpers', () => {
  it('maps severities to badge states and counts the headline figures', () => {
    expect(severityState('Critical')).toBe('down');
    expect(severityState('high')).toBe('degraded');
    expect(severityState('medium')).toBe('at_risk');
    expect(severityState('low')).toBe('unknown');
    expect(severityState('weird')).toBe('unknown');
    expect(headline(summaries)).toEqual({ critical: 1, exploited: 1, internetFacing: 1 });
    expect(exposureFilter('')).toBeNull();
    expect(exposureFilter('internet')).toBe(true);
    expect(exposureFilter('internal')).toBe(false);
  });
});

describe.each(LOCALES)('VulnerabilitiesView (%s)', (locale) => {
  it('lists CVEs highest first and opens the blast radius of a selected one', async () => {
    mount(locale);
    const buttons = await screen.findAllByRole('button', { pressed: false });
    expect(buttons.map((b) => b.textContent)).toEqual(['CVE-2026-0001', 'CVE-2026-0002', 'CVE-2025-9999']);
    expect(screen.getByText(translate(locale, 'vulnerabilities.flag.cisaKev'))).toBeTruthy();
    const region = screen.getByRole('region', { name: translate(locale, 'vulnerabilities.detail.title') });
    expect(within(region).getByText(translate(locale, 'vulnerabilities.detail.pick'))).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', {
        name: translate(locale, 'vulnerabilities.select', { cve: 'CVE-2026-0001' }),
      }),
    );
    await within(region).findByText('Remote code execution in the wire protocol');
    expect(within(region).getByText('db-ryd-pg-core-02')).toBeTruthy();
    expect(within(region).getByText('Ledger')).toBeTruthy();
    expect(within(region).getByText(translate(locale, 'impact.predicted.down'))).toBeTruthy();
    expect(within(region).getByText(translate(locale, 'impact.predicted.at_risk'))).toBeTruthy();
    expect(
      within(region).getByText(translate(locale, 'vulnerabilities.detail.truncated', { count: '25' })),
    ).toBeTruthy();
    expect(
      state.calls.some((c) => c.op === 'Vulnerability' && c.variables['cveId'] === 'CVE-2026-0001'),
    ).toBe(true);
  });

  it('sends the CVSS floor, exposure and exploited filters to the query', async () => {
    mount(locale);
    await screen.findAllByRole('button', { pressed: false });
    fireEvent.change(screen.getByLabelText(translate(locale, 'vulnerabilities.filter.minCvss')), {
      target: { value: '7' },
    });
    await waitFor(() => {
      expect(state.calls.some((c) => c.op === 'VulnerabilitySummaries' && c.variables['minCvss'] === 7)).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('CVE-2025-9999')).toBeNull();
    });
    fireEvent.change(screen.getByLabelText(translate(locale, 'vulnerabilities.filter.exposure')), {
      target: { value: 'internet' },
    });
    fireEvent.click(screen.getByLabelText(translate(locale, 'vulnerabilities.filter.exploitedOnly')));
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) =>
            c.op === 'VulnerabilitySummaries' &&
            c.variables['internetFacing'] === true &&
            c.variables['exploitedOnly'] === true,
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText('CVE-2026-0002')).toBeNull();
    });
  });
});
