// T-159 REQ-DEP-004 (ADR-031) — the layered application map in en and ar against stubbed GraphQL: picking an
// application writes it to the URL; the map draws the tiers in order with each component's technology and port, one
// row per placement layer with the VM and the hypervisor under the component that runs on them; a layer chip hides
// its row through the URL; the dependency list splits internal, outbound and inbound with the evidence of a derived
// dependency; a non-application id says so; the arrangement helpers walk the placement chain.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import type { ApplicationMap } from '@/lib/application-map-queries';
import { ApplicationMapView } from './ApplicationMapView';
import { dependencyCounts, placementLayers, placementsByComponent } from './application-layers';

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

const ci = (id: string, name: string, type: string, layer: string) => ({ id, name, displayName: name, code: name.toUpperCase(), type, layer, health: 'healthy' });
const app = ci('app', 'aml', 'application', 'applications');
const web = ci('web', 'aml-web', 'application_component', 'applications');
const api = ci('api', 'aml-api', 'application_component', 'applications');
const db = ci('db', 'aml-db', 'application_component', 'applications');
const sso = ci('sso', 'iam-sso-api', 'application_component', 'applications');
const ssoApp = ci('sso-app', 'iam-sso', 'application', 'applications');
const vm = ci('vm-web', 'web-ryd-aml-01', 'vm', 'virtualization');
const hv = ci('hv', 'esx-ryd-07', 'hypervisor', 'virtualization');
const host = ci('host-db', 'db-ryd-aml-01', 'host', 'hardware');

const map = {
  application: app,
  services: [ci('svc', 'Anti-money laundering', 'business_service', 'applications')],
  tiers: [
    { tier: 'web', components: [{ ci: web, tier: 'web', technology: 'NGINX 1.26', protocol: 'https', port: 443, deployment: 'virtual_machines', instances: 2 }] },
    { tier: 'api', components: [{ ci: api, tier: 'api', technology: 'Spring Boot 3.3', protocol: 'https', port: 8443, deployment: 'virtual_machines', instances: 3 }] },
    { tier: 'db', components: [{ ci: db, tier: 'db', technology: 'Oracle 19c', protocol: 'tcp', port: 1521, deployment: 'database_cluster', instances: 2 }] },
  ],
  placements: [
    { ci: vm, parentId: 'web', relationship: 'runs_on', hop: 1 },
    { ci: hv, parentId: 'vm-web', relationship: 'hosted_on', hop: 2 },
    { ci: host, parentId: 'db', relationship: 'runs_on', hop: 1 },
  ],
  dependencies: [
    { id: 'd1', from: web, to: api, type: 'depends_on', direction: 'internal', otherApplication: null, derived: true, protocol: 'tcp', ports: [8443], flows: 25243178, confidence: 0.85 },
    { id: 'd2', from: api, to: sso, type: 'depends_on', direction: 'outbound', otherApplication: ssoApp, derived: true, protocol: 'tcp', ports: [8443], flows: 14499338, confidence: 0.85 },
  ],
  truncated: false,
  durationMs: 31,
} as unknown as ApplicationMap;

const calls: Array<Record<string, unknown>> = [];
let answer: ApplicationMap | null = map;

function respond(body: { query: string; variables?: Record<string, unknown> }): unknown {
  if (body.query.includes('query ApplicationMap(')) {
    calls.push(body.variables ?? {});
    return { data: { applicationMap: answer } };
  }
  if (body.query.includes('query CisPage(')) return { data: { cis: { totalCount: 2, edges: [{ node: app }, { node: ssoApp }] } } };
  return { errors: [{ message: 'unexpected operation' }] };
}

beforeEach(() => {
  nav.search = '';
  answer = map;
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
  router.replace.mockReset();
});

describe('application layers', () => {
  it('walks the placement chain per component and lists the layers in order', () => {
    const by = placementsByComponent(map);
    expect(by.get('web')?.map((p) => p.ci.id)).toEqual(['vm-web', 'hv']);
    expect(by.get('db')?.map((p) => p.ci.id)).toEqual(['host-db']);
    expect(by.get('api')).toEqual([]);
    expect(placementLayers(map)).toEqual(['hardware', 'virtualization']);
    expect(dependencyCounts(map)).toEqual({ internal: 1, outbound: 1, inbound: 0 });
  });
});

describe.each(LOCALES)('ApplicationMapView (%s)', (locale) => {
  function mount(): void {
    render(
      <Providers locale={locale}>
        <ApplicationMapView locale={locale} />
      </Providers>,
    );
  }

  it('asks for an application and writes the choice to the URL', async () => {
    mount();
    expect(screen.getByText(translate(locale, 'appmap.none'))).toBeTruthy();
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: translate(locale, 'appmap.application') });
    await within(select).findByRole('option', { name: 'aml' });
    fireEvent.change(select, { target: { value: 'app' } });
    expect(router.replace).toHaveBeenLastCalledWith('/en/dependencies?app=app', { scroll: false });
  });

  it('draws tiers, placements by layer and the dependencies with their evidence', async () => {
    nav.search = 'view=application&app=app';
    mount();
    const grid = await screen.findByRole('table', { name: translate(locale, 'appmap.grid') });
    expect(calls[0]).toEqual({ id: 'app' });
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([translate(locale, 'appmap.tier'), 'web', 'api', 'db']);
    expect(within(grid).getAllByTestId('appmap-component')).toHaveLength(3);
    expect(within(grid).getByText('Spring Boot 3.3')).toBeTruthy();
    expect(within(grid).getByText('tcp/1521')).toBeTruthy();
    const virtual = screen.getByTestId('appmap-layer-virtualization');
    expect(within(virtual).getByRole('link', { name: 'web-ryd-aml-01' })).toBeTruthy();
    expect(within(virtual).getByRole('link', { name: 'esx-ryd-07' })).toBeTruthy();
    expect(within(screen.getByTestId('appmap-layer-hardware')).getByRole('link', { name: 'db-ryd-aml-01' })).toBeTruthy();
    const internal = screen.getByTestId('appmap-deps-internal');
    expect(within(internal).getByText(translate(locale, 'appmap.dep.derived', { type: 'depends_on' }))).toBeTruthy();
    expect(within(internal).getByText('tcp/8443')).toBeTruthy();
    const outbound = screen.getByTestId('appmap-deps-outbound');
    expect(within(outbound).getByText('iam-sso')).toBeTruthy();
    expect(screen.queryByTestId('appmap-deps-inbound')).toBeNull();
    const layers = screen.getByRole('group', { name: translate(locale, 'appmap.layers') });
    fireEvent.click(within(layers).getByRole('button', { name: translate(locale, 'layer.virtualization') }));
    expect(router.replace).toHaveBeenLastCalledWith('/en/dependencies?view=application&app=app&hide=virtualization', { scroll: false });
  });

  it('hides a layer named in the URL and says when the id is not an application', async () => {
    nav.search = 'view=application&app=app&hide=virtualization';
    mount();
    await screen.findByRole('table', { name: translate(locale, 'appmap.grid') });
    expect(screen.queryByTestId('appmap-layer-virtualization')).toBeNull();
    expect(screen.getByTestId('appmap-layer-hardware')).toBeTruthy();
    cleanup();
    answer = null;
    mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(translate(locale, 'appmap.notApplication'))).toBeTruthy();
  });
});
