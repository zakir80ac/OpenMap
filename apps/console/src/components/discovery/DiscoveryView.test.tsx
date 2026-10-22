// T-067 REQ-UI-006 REQ-DISC-029 REQ-DISC-031 — DiscoveryView renders Nodes with collectors, jobs, sweep progress and
// starts a sweep through runDiscovery, in en and ar over stubbed GraphQL.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal<typeof AuthModule>()), useCan: () => () => true }));

import { Providers } from '@/providers';
import { DiscoveryView, collectorsByNode, jobDurationSeconds, jobState, nodeState, sweepElapsedMinutes } from './DiscoveryView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/discovery',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const nodes = [
  { id: 'node-ryd-1', site: { id: 'site-ryd', displayName: 'Riyadh DC' }, status: 'online', lastHeartbeat: '2026-10-22T09:40:00.000Z', activeJobs: 2, certificateExpiresAt: '2027-01-20T00:00:00.000Z' },
  { id: 'node-jed-1', site: null, status: 'offline', lastHeartbeat: '2026-10-21T09:40:00.000Z', activeJobs: 0, certificateExpiresAt: '2027-01-20T00:00:00.000Z' },
];

const jobs = [
  { id: 'job-1', collectorId: 'snmp', node: { id: 'node-ryd-1' }, status: 'running', targets: 256, scheduledAt: '2026-10-22T09:30:00.000Z', startedAt: '2026-10-22T09:31:00.000Z', finishedAt: null, cisEmitted: 1200, errors: 0 },
  { id: 'job-2', collectorId: 'ssh_agentless', node: { id: 'node-ryd-1' }, status: 'succeeded', targets: 128, scheduledAt: '2026-10-22T09:00:00.000Z', startedAt: '2026-10-22T09:01:00.000Z', finishedAt: '2026-10-22T09:04:30.000Z', cisEmitted: 3400, errors: 3 },
  { id: 'job-3', collectorId: 'port_scan', node: { id: 'node-jed-1' }, status: 'failed', targets: 64, scheduledAt: '2026-10-22T08:00:00.000Z', startedAt: null, finishedAt: null, cisEmitted: 0, errors: 1 },
];

const sweep = { id: 'sweep-9', startedAt: '2026-10-22T09:30:00.000Z', finishedAt: null, targetsTotal: 10000, targetsDone: 4200, devicesDiscovered: 3900, budgetMinutes: 15 };

const state = { sweep: null as typeof sweep | null, calls: [] as string[] };

function respond(body: { query: string }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  state.calls.push(op);
  switch (op) {
    case 'DiscoveryNodes':
      return { data: { discoveryNodes: nodes } };
    case 'DiscoveryJobs':
      return { data: { discoveryJobs: jobs } };
    case 'CurrentSweep':
      return { data: { currentSweep: state.sweep } };
    case 'RunDiscovery':
      state.sweep = sweep;
      return { data: { runDiscovery: sweep } };
    default:
      return { errors: [{ message: 'unexpected operation ' + op }] };
  }
}

beforeEach(() => {
  state.sweep = null;
  state.calls = [];
  process.env['NEXT_PUBLIC_API_URL'] = 'http://api.test';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      return Promise.resolve(new Response(JSON.stringify(respond(JSON.parse(raw) as { query: string })), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('discovery helpers', () => {
  it('maps statuses to UI states and collects collectors per node', () => {
    expect(nodeState('online')).toBe('healthy');
    expect(nodeState('offline')).toBe('down');
    expect(nodeState('weird')).toBe('unknown');
    expect(jobState('running')).toBe('at_risk');
    expect(jobState('failed')).toBe('down');
    expect(collectorsByNode(jobs as never).get('node-ryd-1')).toEqual(['snmp', 'ssh_agentless']);
    expect(collectorsByNode(jobs as never).get('node-jed-1')).toEqual(['port_scan']);
  });
  it('computes job durations and sweep elapsed minutes', () => {
    const now = new Date('2026-10-22T09:45:00.000Z').getTime();
    expect(jobDurationSeconds(jobs[1] as never, now)).toBe(210);
    expect(jobDurationSeconds(jobs[0] as never, now)).toBe(14 * 60);
    expect(jobDurationSeconds(jobs[2] as never, now)).toBeUndefined();
    expect(sweepElapsedMinutes(sweep, now)).toBe(15);
  });
});

describe.each(LOCALES)('DiscoveryView in %s', (locale) => {
  it('renders nodes with site, heartbeat and collectors, and the jobs table', async () => {
    render(
      <Providers locale={locale}>
        <DiscoveryView locale={locale} />
      </Providers>,
    );
    expect((await screen.findAllByText('node-ryd-1')).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Riyadh DC' }).getAttribute('href')).toBe('/' + locale + '/cmdb/site-ryd');
    expect(screen.getByText(translate(locale, 'discovery.nodes.noSite'))).toBeTruthy();
    expect(screen.getAllByText('snmp').length).toBeGreaterThan(0);
    expect(screen.getByText(translate(locale, 'discovery.nodes.status.offline'))).toBeTruthy();
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(jobs.length + 1);
    expect(within(table).getByText(translate(locale, 'discovery.jobs.status.failed'))).toBeTruthy();
    expect(within(table).getByText(translate(locale, 'discovery.jobs.notStarted'))).toBeTruthy();
    expect(within(table).getByText(translate(locale, 'discovery.jobs.duration', { seconds: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(210) }))).toBeTruthy();
    expect(screen.getByText(translate(locale, 'discovery.sweep.none'))).toBeTruthy();
  });

  it('starts a sweep through runDiscovery and shows its progress', async () => {
    render(
      <Providers locale={locale}>
        <DiscoveryView locale={locale} />
      </Providers>,
    );
    const button = await screen.findByRole('button', { name: translate(locale, 'discovery.run') });
    fireEvent.click(button);
    await waitFor(() => {
      expect(state.calls).toContain('RunDiscovery');
    });
    await waitFor(() => {
      expect(screen.getByRole('progressbar', { name: translate(locale, 'discovery.sweep.label') }).getAttribute('aria-valuenow')).toBe('4200');
    });
    const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    expect(screen.getByText(translate(locale, 'discovery.sweep.progress', { done: nf.format(4200), total: nf.format(10000) }))).toBeTruthy();
    expect(screen.getByText(translate(locale, 'discovery.runStarted', { id: 'sweep-9' }))).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: translate(locale, 'discovery.run') }).disabled).toBe(true);
  });
});
