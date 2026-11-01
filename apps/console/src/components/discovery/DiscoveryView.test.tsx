// T-067 REQ-UI-006 REQ-DISC-029 REQ-DISC-031 — DiscoveryView renders Nodes with collectors, jobs, sweep progress and
// starts a sweep through runDiscovery, in en and ar over stubbed GraphQL.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthModule from '@/lib/auth';
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  useCan: () => () => true,
}));

import { Providers } from '@/providers';
import {
  DiscoveryView,
  parseExclusions,
  parseLimit,
  collectorsByNode,
  jobDurationSeconds,
  jobState,
  nodeState,
  sweepElapsedMinutes,
} from './DiscoveryView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/discovery',
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const nodes = [
  {
    id: 'node-ryd-1',
    site: { id: 'site-ryd', displayName: 'Riyadh DC' },
    status: 'online',
    lastHeartbeat: '2026-10-22T09:40:00.000Z',
    activeJobs: 2,
    certificateExpiresAt: '2027-01-20T00:00:00.000Z',
  },
  {
    id: 'node-jed-1',
    site: null,
    status: 'offline',
    lastHeartbeat: '2026-10-21T09:40:00.000Z',
    activeJobs: 0,
    certificateExpiresAt: '2027-01-20T00:00:00.000Z',
  },
];

const jobs = [
  {
    id: 'job-1',
    collectorId: 'snmp',
    node: { id: 'node-ryd-1' },
    status: 'running',
    targets: 256,
    scheduledAt: '2026-10-22T09:30:00.000Z',
    startedAt: '2026-10-22T09:31:00.000Z',
    finishedAt: null,
    cisEmitted: 1200,
    errors: 0,
  },
  {
    id: 'job-2',
    collectorId: 'ssh_agentless',
    node: { id: 'node-ryd-1' },
    status: 'succeeded',
    targets: 128,
    scheduledAt: '2026-10-22T09:00:00.000Z',
    startedAt: '2026-10-22T09:01:00.000Z',
    finishedAt: '2026-10-22T09:04:30.000Z',
    cisEmitted: 3400,
    errors: 3,
  },
  {
    id: 'job-3',
    collectorId: 'port_scan',
    node: { id: 'node-jed-1' },
    status: 'failed',
    targets: 64,
    scheduledAt: '2026-10-22T08:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    cisEmitted: 0,
    errors: 1,
  },
];

const sweep = {
  id: 'sweep-9',
  startedAt: '2026-10-22T09:30:00.000Z',
  finishedAt: null,
  targetsTotal: 10000,
  targetsDone: 4200,
  devicesDiscovered: 3900,
  budgetMinutes: 15,
};

const scopes = [
  {
    ci: {
      id: 'subnet-1',
      name: 'mgmt',
      displayName: 'Management /24',
      code: 'NET-MGMT',
      type: 'subnet',
      layer: 'network_security',
      health: 'healthy',
    },
    cidr: '10.0.0.0/24',
    site: {
      id: 'site-ryd-ci',
      name: 'RYD',
      displayName: 'Riyadh DC',
      code: 'FAC-RYD',
      type: 'site',
      layer: 'dc',
      health: 'healthy',
    },
    exclusions: ['10.0.0.250/32'],
    credentialRef: 'secret/openmap/snmp',
    credentialType: 'snmp_v3',
    rateLimitConcurrency: 8,
    rateLimitRps: 40,
  },
  {
    ci: {
      id: 'subnet-2',
      name: 'ot',
      displayName: 'OT /24',
      code: 'NET-OT',
      type: 'subnet',
      layer: 'network_security',
      health: 'healthy',
    },
    cidr: '10.9.0.0/24',
    site: null,
    exclusions: [],
    credentialRef: null,
    credentialType: 'none',
    rateLimitConcurrency: null,
    rateLimitRps: null,
  },
];

const state = {
  sweep: null as typeof sweep | null,
  calls: [] as string[],
  scopeInputs: [] as Array<Record<string, unknown>>,
};

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  const op = /^(query|mutation) (\w+)/.exec(body.query)?.[2] ?? 'unknown';
  state.calls.push(op);
  switch (op) {
    case 'DiscoveryScopes':
      return { data: { discoveryScopes: scopes } };
    case 'UpdateDiscoveryScope': {
      const input = (body.variables?.['input'] ?? {}) as Record<string, unknown>;
      state.scopeInputs.push(input);
      return { data: { updateDiscoveryScope: { ...scopes[1], ...input } } };
    }
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
  state.scopeInputs = [];
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
    expect(screen.getByRole('link', { name: 'Riyadh DC' }).getAttribute('href')).toBe(
      '/' + locale + '/cmdb/site-ryd',
    );
    expect(screen.getByText(translate(locale, 'discovery.nodes.noSite'))).toBeTruthy();
    expect(screen.getAllByText('snmp').length).toBeGreaterThan(0);
    expect(screen.getByText(translate(locale, 'discovery.nodes.status.offline'))).toBeTruthy();
    // The jobs table comes first; the scopes card below has its own.
    const table = (await screen.findAllByRole('table'))[0] ?? document.body;
    expect(within(table).getAllByRole('row')).toHaveLength(jobs.length + 1);
    expect(within(table).getByText(translate(locale, 'discovery.jobs.status.failed'))).toBeTruthy();
    expect(within(table).getByText(translate(locale, 'discovery.jobs.notStarted'))).toBeTruthy();
    expect(
      within(table).getByText(
        translate(locale, 'discovery.jobs.duration', {
          seconds: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(210),
        }),
      ),
    ).toBeTruthy();
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
      expect(
        screen
          .getByRole('progressbar', { name: translate(locale, 'discovery.sweep.label') })
          .getAttribute('aria-valuenow'),
      ).toBe('4200');
    });
    const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    expect(
      screen.getByText(
        translate(locale, 'discovery.sweep.progress', { done: nf.format(4200), total: nf.format(10000) }),
      ),
    ).toBeTruthy();
    expect(screen.getByText(translate(locale, 'discovery.runStarted', { id: 'sweep-9' }))).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: translate(locale, 'discovery.run') }).disabled,
    ).toBe(true);
  });

  it('lists discovery scopes and lets an operator save exclusions, credential set and rate limit', async () => {
    render(
      <Providers locale={locale}>
        <DiscoveryView locale={locale} />
      </Providers>,
    );
    const card = await screen.findByRole('region', { name: translate(locale, 'discovery.scopes.title') });
    expect(await within(card).findByText('10.0.0.0/24')).toBeTruthy();
    expect(within(card).getByText('10.0.0.250/32')).toBeTruthy();
    expect(within(card).getByText(translate(locale, 'discovery.scopes.defaultLimit'))).toBeTruthy();
    fireEvent.click(
      within(card).getByRole('button', {
        name: translate(locale, 'discovery.scopes.editOf', { cidr: '10.9.0.0/24' }),
      }),
    );
    const form = within(card).getByRole('form', {
      name: translate(locale, 'discovery.scopes.form', { cidr: '10.9.0.0/24' }),
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'discovery.scopes.exclusions')), {
      target: { value: '10.9.0.1/32\n10.9.0.128/25' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'discovery.scopes.credentialType')), {
      target: { value: 'snmp_v2c' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'discovery.scopes.credentialRef')), {
      target: { value: 'secret/openmap/ot' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'discovery.scopes.concurrency')), {
      target: { value: '2' },
    });
    fireEvent.change(within(form).getByLabelText(translate(locale, 'discovery.scopes.rps')), {
      target: { value: '5' },
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(state.scopeInputs).toEqual([
        {
          exclusions: ['10.9.0.1/32', '10.9.0.128/25'],
          credentialRef: 'secret/openmap/ot',
          credentialType: 'snmp_v2c',
          rateLimitConcurrency: 2,
          rateLimitRps: 5,
        },
      ]);
    });
    await waitFor(() => {
      expect(
        within(card).queryByRole('form', {
          name: translate(locale, 'discovery.scopes.form', { cidr: '10.9.0.0/24' }),
        }),
      ).toBeNull();
    });
  });
});

describe('scope form helpers', () => {
  it('parses exclusions from lines or commas and limits from text', () => {
    expect(parseExclusions('10.0.0.0/24\n, 10.0.1.0/24 ,\n\n')).toEqual(['10.0.0.0/24', '10.0.1.0/24']);
    expect(parseLimit('')).toBeNull();
    expect(parseLimit('0')).toBeNull();
    expect(parseLimit('abc')).toBeNull();
    expect(parseLimit(' 12 ')).toBe(12);
  });
});
