// T-626 REQ-INT-011 (ADR-072) — the configuration-management inventory card in en and ar: the live size of the
// inventory from the Ansible route (with the user's token), every tool's endpoint on this deployment with its shipped
// client, and a download of a tool's document in its own format.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthHooks } from '@/lib/graphql';
import { Providers } from '@/providers';
import { INVENTORY_TOOLS, InventoryCard, inventorySize } from './InventoryCard';

const API = 'http://api.test';
const inventory = {
  _meta: { hostvars: { 'app-01.bank.local': { ansible_host: '192.0.2.11' }, 'vm-02': {} } },
  all: { children: ['ungrouped', 'openmap_site', 'openmap_service'] },
  openmap_site: { children: ['site_hq'] },
  openmap_service: { children: ['service_bs_pay', 'service_bs_web'] },
  site_hq: { hosts: ['app-01.bank.local', 'vm-02'] },
  service_bs_pay: { hosts: ['app-01.bank.local'] },
  service_bs_web: { hosts: ['vm-02'] },
  ungrouped: { hosts: [] },
};
const calls: Array<{ url: string; authorization: string | undefined }> = [];

beforeEach(() => {
  calls.length = 0;
  process.env['NEXT_PUBLIC_API_URL'] = API;
  setAuthHooks({ getAccessToken: () => 'tok', onUnauthorized: () => undefined });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.['authorization'] });
      return Promise.resolve(new Response(JSON.stringify(inventory), { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:inventory', revokeObjectURL: () => undefined }));
  // jsdom does not navigate; the download link's click is the browser's part.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  setAuthHooks(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('inventorySize', () => {
  it('counts nodes, sites and services', () => {
    expect(inventorySize(inventory)).toEqual({ nodes: 2, sites: 1, services: 2 });
  });
});

describe.each(LOCALES)('configuration-management inventory card (%s)', (locale) => {
  it('shows the live inventory size, every endpoint and client, and downloads a document', async () => {
    render(
      <Providers locale={locale}>
        <InventoryCard />
      </Providers>,
    );
    const card = await screen.findByRole('region', { name: translate(locale, 'integrations.inventory.title') });
    await waitFor(() => {
      expect(within(card).getByText(translate(locale, 'integrations.inventory.services')).parentElement?.textContent).toContain('2');
    });
    expect(calls[0]).toEqual({ url: API + '/api/v1/inventory/ansible?groupBy=site,service', authorization: 'Bearer tok' });
    const table = within(card).getByRole('table', { name: translate(locale, 'integrations.inventory.endpoints') });
    expect(within(table).getAllByRole('row')).toHaveLength(INVENTORY_TOOLS.length + 1);
    expect(within(table).getByText(API + '/api/v1/inventory/salt')).toBeTruthy();
    expect(within(table).getByText(API + '/api/v1/inventory/puppet/nodes/{certname}')).toBeTruthy();
    expect(within(table).getByText('tools/inventory/ansible/openmap_inventory.py')).toBeTruthy();
    const tool = translate(locale, 'integrations.inventory.tool.salt');
    fireEvent.click(within(table).getByRole('button', { name: translate(locale, 'integrations.inventory.downloadTool', { tool }) }));
    await waitFor(() => {
      expect(calls.map((c) => c.url)).toContain(API + '/api/v1/inventory/salt?format=yaml');
    });
    expect(within(card).getByText(translate(locale, 'integrations.inventory.token'))).toBeTruthy();
  });
});
