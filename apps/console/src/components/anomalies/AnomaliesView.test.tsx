// T-505 REQ-AI-003 — the Anomalies screen over stubbed GraphQL, in en and ar:
// - each finding with its rule, subject, facts (instants in the reader's format) and state, and the per-rule counts;
// - Explain asks for the explanation in the screen's locale and shows it; an operator can run the rules now.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { AnomaliesView } from './AnomaliesView';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/en/anomalies' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<object>()), useCan: () => () => true }));

const ci = (id: string, displayName: string) => ({ id, name: id, displayName, code: id.toUpperCase(), type: 'ip_address', layer: 'network_security', health: 'unknown' });
const report = {
  open: 2,
  lastSweepAt: '2026-11-08T07:00:00.000Z',
  findings: [
    { id: 'f1', rule: 'ip_conflict', subject: ci('ip1', '10.50.0.10'), facts: [{ key: 'address', value: '10.50.0.10' }, { key: 'claimants', value: 'iot_sensor-b6ff (unknown), srv-ryd-app-01 (host)' }], state: 'open', detectedAt: '2026-11-08T07:00:00.000Z', lastSeenAt: '2026-11-08T07:00:00.000Z', clearedAt: null, explanation: null, explanationLocale: null },
    { id: 'f2', rule: 'flapping_service', subject: ci('svc', 'SARIE Instant Payments'), facts: [{ key: 'changes', value: '8' }, { key: 'from', value: '2026-11-08T02:00:00.000Z' }], state: 'open', detectedAt: '2026-11-08T07:00:00.000Z', lastSeenAt: '2026-11-08T07:00:00.000Z', clearedAt: null, explanation: null, explanationLocale: null },
    { id: 'f3', rule: 'unmanaged_device_in_datacenter', subject: ci('cam', 'camera-6e2c'), facts: [{ key: 'site', value: 'Riyadh Primary Data Centre' }], state: 'cleared', detectedAt: '2026-11-07T07:00:00.000Z', lastSeenAt: '2026-11-07T09:00:00.000Z', clearedAt: '2026-11-07T10:00:00.000Z', explanation: null, explanationLocale: null },
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
      const data = body.query.includes('explainAnomaly')
        ? { explainAnomaly: { id: 'f1', explanation: 'Two devices answer on 10.50.0.10.' } }
        : body.query.includes('detectAnomalies')
          ? { detectAnomalies: report }
          : { anomalies: report };
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('AnomaliesView in %s', (locale) => {
  it('lists the findings with their facts and explains one on request', async () => {
    render(
      <Providers locale={locale}>
        <AnomaliesView locale={locale} />
      </Providers>,
    );
    const list = await screen.findByRole('list', { name: translate(locale, 'anomaly.list') });
    const conflict = within(list).getByRole('listitem', { name: translate(locale, 'anomaly.rule.ip_conflict') });
    expect(within(conflict).getByRole('link', { name: '10.50.0.10' })).toBeTruthy();
    expect(within(conflict).getByText(translate(locale, 'anomaly.fact.claimants'))).toBeTruthy();
    expect(within(conflict).getByText('iot_sensor-b6ff (unknown), srv-ryd-app-01 (host)')).toBeTruthy();
    const flapping = within(list).getByRole('listitem', { name: translate(locale, 'anomaly.rule.flapping_service') });
    expect(within(flapping).queryByText('2026-11-08T02:00:00.000Z')).toBeNull();
    const cleared = within(list).getByRole('listitem', { name: translate(locale, 'anomaly.rule.unmanaged_device_in_datacenter') });
    expect(within(cleared).getByText(translate(locale, 'anomaly.state.cleared'))).toBeTruthy();
    const summary = screen.getByRole('group', { name: translate(locale, 'anomaly.summary') });
    expect(within(summary).getByText(translate(locale, 'anomaly.summary.open')).parentElement?.textContent).toContain(new Intl.NumberFormat(locale).format(2));

    fireEvent.click(within(conflict).getByRole('button', { name: translate(locale, 'anomaly.explain') }));
    expect(await within(conflict).findByText('Two devices answer on 10.50.0.10.')).toBeTruthy();
    expect(sent.find((s) => s.query.includes('explainAnomaly'))?.variables).toEqual({ id: 'f1', locale });

    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'anomaly.detect') }));
    await waitFor(() => {
      expect(sent.some((s) => s.query.includes('detectAnomalies'))).toBe(true);
    });
  });
});
