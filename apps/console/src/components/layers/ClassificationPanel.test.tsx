// T-500 REQ-AI-002 — the suggested classifications on the Layers screen over stubbed GraphQL, in en and ar:
// - each suggestion with the CI, the class, layer and type, the confidence and the evidence;
// - the open count, the unrecognised count and the acceptance rate;
// - an operator's Accept and Dismiss send the decision for that suggestion; an analyst sees no buttons.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { ClassificationPanel } from './ClassificationPanel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/en/layers' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
let operator = true;
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<object>()), useCan: () => () => operator }));

const ci = (id: string, displayName: string) => ({ id, name: id, displayName, code: id.toUpperCase(), type: 'unknown', layer: 'unknown', health: 'unknown' });
const summary = {
  unrecognised: 2,
  accepted: 3,
  dismissed: 1,
  acceptanceRate: 0.75,
  open: [
    {
      id: 's-ups',
      ci: ci('ups', 'ups_card-4416'),
      deviceClass: 'ups_management',
      layer: 'dc',
      type: 'ups',
      title: 'APC Web/SNMP Management Card (MB:v4.1.0 MN:AP9641)',
      confidence: 0.95,
      evidence: [
        { signal: 'sysDescr', value: 'Management Card', weight: 0.5 },
        { signal: 'ports', value: '161', weight: 0.2 },
      ],
    },
    {
      id: 's-cam',
      ci: ci('cam', 'camera-541b'),
      deviceClass: 'network_camera',
      layer: 'dc',
      type: null,
      title: 'AXIS P3245-LVE Network Camera 10.12.166',
      confidence: 1,
      evidence: [{ signal: 'sysDescr', value: 'Camera', weight: 0.5 }],
    },
  ],
};

const sent: Array<{ query: string; variables: unknown }> = [];

beforeEach(() => {
  operator = true;
  sent.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: unknown };
      sent.push(body);
      const data = body.query.startsWith('mutation') ? { acceptClassificationSuggestion: { id: 's-ups', state: 'accepted' }, dismissClassificationSuggestion: { id: 's-cam', state: 'dismissed' } } : { classificationSuggestions: summary };
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(LOCALES)('ClassificationPanel in %s', (locale) => {
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);

  it('lists the suggestions with their evidence and the acceptance rate, and sends decisions', async () => {
    render(
      <Providers locale={locale}>
        <ClassificationPanel locale={locale} />
      </Providers>,
    );
    const list = await screen.findByRole('list', { name: translate(locale, 'classify.list') });
    const ups = within(list).getByRole('listitem', { name: 'ups_card-4416' });
    expect(within(ups).getByText(translate(locale, 'classify.class.ups_management'))).toBeTruthy();
    expect(within(ups).getByText(translate(locale, 'classify.type', { type: 'ups' }))).toBeTruthy();
    expect(within(ups).getByText(translate(locale, 'classify.confidence', { value: n(95) }))).toBeTruthy();
    expect(within(ups).getByText(translate(locale, 'classify.signal.ports') + ': 161')).toBeTruthy();
    expect(within(ups).getByText('APC Web/SNMP Management Card (MB:v4.1.0 MN:AP9641)')).toBeTruthy();
    const totals = screen.getByRole('group', { name: translate(locale, 'classify.summary') });
    expect(within(totals).getByText(translate(locale, 'classify.percent', { value: n(75) }))).toBeTruthy();
    expect(within(totals).getByText(translate(locale, 'classify.decided', { accepted: n(3), dismissed: n(1) }))).toBeTruthy();

    fireEvent.click(within(ups).getByRole('button', { name: translate(locale, 'classify.accept') }));
    await waitFor(() => {
      expect(sent.some((b) => b.query.includes('acceptClassificationSuggestion') && JSON.stringify(b.variables) === JSON.stringify({ id: 's-ups' }))).toBe(true);
    });
    const cam = within(list).getByRole('listitem', { name: 'camera-541b' });
    fireEvent.click(within(cam).getByRole('button', { name: translate(locale, 'classify.dismiss') }));
    await waitFor(() => {
      expect(sent.some((b) => b.query.includes('dismissClassificationSuggestion') && JSON.stringify(b.variables) === JSON.stringify({ id: 's-cam' }))).toBe(true);
    });
  });

  it('shows an analyst the suggestions without decision buttons', async () => {
    operator = false;
    render(
      <Providers locale={locale}>
        <ClassificationPanel locale={locale} />
      </Providers>,
    );
    const list = await screen.findByRole('list', { name: translate(locale, 'classify.list') });
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
  });
});
