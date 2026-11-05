// T-155 REQ-DEP-001 (ADR-030) — the network topology view in en and ar against stubbed GraphQL: the L2 map draws the
// devices and their neighbour links (the Sigma canvas is replaced by a probe), the layer, site and host toggle write
// the URL and the query asks for them, clicking a device lists its links with interface pairs, speed and protocol,
// and the panel links to the device's impact map; the graph adapter colours links by the relationship they stand for.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { NetworkTopology } from '@/lib/topology-queries';
import type { DependencyCanvasProps } from './DependencyCanvas';
import { linksOf, topologyGraph } from './topology-graph';
import { TopologyView, parseTopologyLayer } from './TopologyView';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const nav = vi.hoisted(() => ({ search: '' }));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/en/dependencies',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('./DependencyCanvas', () => ({
  DependencyCanvas: ({ graph, label, onSelect, highlight }: DependencyCanvasProps) => (
    <div role="img" aria-label={label} data-testid="canvas-probe" data-highlight={highlight === undefined ? '' : [...highlight].sort().join(',')}>
      {graph.nodes.map((node) => (
        <button key={node.id} type="button" data-testid="probe-node" data-depth={node.depth} onClick={() => { onSelect(node); }}>
          {node.label}
        </button>
      ))}
      <span data-testid="probe-edges">{graph.edges.length}</span>
    </div>
  ),
}));

const ci = (id: string, name: string, type: string, layer: string) => ({ id, name, displayName: name, code: name.toUpperCase(), type, layer, health: 'healthy' });
const core = ci('core', 'ryd-core-01', 'network_device', 'network_security');
const dist = ci('dist', 'ryd-dist-01', 'network_device', 'network_security');
const srv = ci('srv', 'srv-ryd-01', 'host', 'hardware');

const topology: NetworkTopology = {
  layer: 'l2',
  truncated: false,
  durationMs: 42,
  nodes: [
    { degree: 2, ci: core },
    { degree: 1, ci: dist },
    { degree: 1, ci: srv },
  ] as NetworkTopology['nodes'],
  links: [
    { id: 'core:dist:neighbour', from: core, to: dist, kind: 'neighbour', count: 2, ports: ['Ethernet1/1 ↔ Ethernet49/1', 'Ethernet1/2 ↔ Ethernet50/1'], protocols: ['lldp'], media: ['100GBASE-SR4'], speedMbps: 100_000 },
    { id: 'srv:core:host', from: srv, to: core, kind: 'host', count: 1, ports: ['eno1 → Ethernet1/11'], protocols: [], media: ['10GBASE-T'], speedMbps: 10_000 },
  ] as NetworkTopology['links'],
};

const calls: Array<Record<string, unknown>> = [];

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  if (body.query.includes('query NetworkTopology(')) {
    calls.push(body.variables ?? {});
    return { data: { networkTopology: topology } };
  }
  if (body.query.includes('query CisPage(') || body.query.includes('cis(')) return { data: { cis: { totalCount: 1, edges: [{ node: ci('site-ryd', 'RYD', 'site', 'dc') }] } } };
  return { errors: [{ message: 'unexpected operation' }] };
}

beforeEach(() => {
  nav.search = '';
  calls.length = 0;
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
  router.push.mockReset();
  router.replace.mockReset();
});

describe('topology helpers', () => {
  it('reads the layer from the URL and maps the topology onto the canvas graph', () => {
    expect(parseTopologyLayer('l3')).toBe('l3');
    expect(parseTopologyLayer('l7')).toBe('l2');
    expect(parseTopologyLayer(null)).toBe('l2');
    const { graph, edgeTypes } = topologyGraph(topology);
    expect(graph.nodes.map((n) => [n.id, n.depth])).toEqual([
      ['core', 1],
      ['dist', 1],
      ['srv', 3],
    ]);
    expect(edgeTypes.get('core→dist')).toBe('connected_to');
    expect(edgeTypes.get('core→srv')).toBe('cabled_to');
    expect(linksOf(topology, 'core').map((l) => l.other.id)).toEqual(['dist', 'srv']);
  });
});

describe.each(LOCALES)('TopologyView (%s)', (locale) => {
  function mount(): void {
    render(
      <Providers locale={locale}>
        <TopologyView locale={locale} />
      </Providers>,
    );
  }

  it('draws the L2 map and lists a device links with their evidence', async () => {
    mount();
    const probe = await screen.findByTestId('canvas-probe');
    expect(probe.getAttribute('aria-label')).toBe(translate(locale, 'topology.canvas', { layer: translate(locale, 'topology.layer.l2') }));
    expect(within(probe).getByTestId('probe-edges').textContent).toBe('2');
    expect(calls[0]).toEqual({ layer: 'l2', siteId: null, includeHosts: false });
    expect(screen.getByText(translate(locale, 'topology.pick'))).toBeTruthy();
    fireEvent.click(within(probe).getByRole('button', { name: 'ryd-core-01' }));
    const links = await screen.findByTestId('topology-links');
    expect(within(links).getAllByRole('listitem')).toHaveLength(2);
    expect(within(links).getByText('Ethernet1/1 ↔ Ethernet49/1 · Ethernet1/2 ↔ Ethernet50/1')).toBeTruthy();
    expect(within(links).getByText('LLDP')).toBeTruthy();
    expect(within(links).getAllByText(translate(locale, 'topology.kind.host')).length).toBeGreaterThan(0);
    expect(probe.getAttribute('data-highlight')).toBe('core,dist,srv');
    expect(screen.getByRole('link', { name: translate(locale, 'topology.openImpact') }).getAttribute('href')).toContain('?ci=core&direction=both');
  });

  it('writes the layer, site and host choices to the URL and asks for them', async () => {
    nav.search = 'view=topology&hosts=1&site=site-ryd';
    mount();
    await screen.findByTestId('canvas-probe');
    expect(calls[0]).toEqual({ layer: 'l2', siteId: 'site-ryd', includeHosts: true });
    const layer = screen.getByRole('radiogroup', { name: translate(locale, 'topology.layer.label') });
    fireEvent.click(within(layer).getByRole('radio', { name: translate(locale, 'topology.layer.l3') }));
    expect(router.replace).toHaveBeenLastCalledWith('/en/dependencies?view=topology&hosts=1&site=site-ryd&tlayer=l3', { scroll: false });
    fireEvent.click(screen.getByRole('checkbox', { name: translate(locale, 'topology.hosts') }));
    expect(router.replace).toHaveBeenLastCalledWith('/en/dependencies?view=topology&site=site-ryd', { scroll: false });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(translate(locale, 'topology.stats', { nodes: '3', links: '2', ms: '42' }));
    });
  });
});
