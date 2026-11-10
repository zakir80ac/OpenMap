'use client';
// REQ-INT-011 (ADR-072) — configuration-management inventory on the Integrations screen: the live size of the inventory
// (nodes, sites, business services, from the Ansible route with the signed-in user's token), every tool's endpoint on
// this deployment with the client script shipped in tools/inventory and how to run it, a download of each document, and
// how a script obtains a token (the automation client's credentials grant) and narrows the inventory with filters.
import { useQuery } from '@tanstack/react-query';
import { INVENTORY } from '@openmap/constants';
import { REST_BASE_PATH, REST_ROUTES, type AnsibleInventory, type RestRouteId } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Card, Kpi, SectionTitle } from '@openmap/ui';
import type { ReactNode } from 'react';
import { Button, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { restBase } from '@/components/settings/ApiCard';
import { downloadFromApi, getFromApi } from '@/lib/graphql';
import { useFormatters, useT } from '@/providers';

export type InventoryTool = 'ansible' | 'salt' | 'puppet' | 'chef';

interface ToolRow {
  tool: InventoryTool;
  route: RestRouteId;
  /** Query a download asks for: the tool's own format. */
  download: string;
  file: string;
  client: string;
  usage: string;
}

/** The tools, their routes and the shipped clients; commands are shell, not prose, and stay untranslated. */
export const INVENTORY_TOOLS: readonly ToolRow[] = [
  { tool: 'ansible', route: 'ansibleInventory', download: '', file: 'openmap-ansible.json', client: INVENTORY.clients.ansibleScript, usage: 'ansible-inventory -i ' + INVENTORY.clients.ansibleScript + ' --graph' },
  { tool: 'salt', route: 'saltRoster', download: '?format=yaml', file: 'openmap-roster.yaml', client: INVENTORY.clients.saltRoster, usage: 'python3 ' + INVENTORY.clients.saltRoster + ' -o roster && salt-ssh --roster-file roster "*" test.ping' },
  { tool: 'puppet', route: 'puppetNodes', download: '?format=yaml', file: 'openmap-puppet.yaml', client: INVENTORY.clients.puppetEnc, usage: 'puppet config set node_terminus exec && puppet config set external_nodes ' + INVENTORY.clients.puppetEnc },
  { tool: 'chef', route: 'chefExport', download: '', file: 'openmap-chef.json', client: INVENTORY.clients.chefExport, usage: 'python3 ' + INVENTORY.clients.chefExport + ' --out chef && knife role from file chef/roles/*.json && knife node from file chef/nodes/*.json' },
];

const PREVIEW_QUERY = '?groupBy=site,service';
const SITE_PARENT = INVENTORY.prefix + '_site';
const SERVICE_PARENT = INVENTORY.prefix + '_service';

/** The Ansible document the size is read from, grouped by the two facets the card counts. */
function loadPreview({ signal }: { signal: AbortSignal }): Promise<AnsibleInventory> {
  return getFromApi(REST_BASE_PATH + REST_ROUTES.ansibleInventory.path + PREVIEW_QUERY, signal);
}

function toolKey(tool: InventoryTool): MessageKey {
  return ('integrations.inventory.tool.' + tool) as MessageKey;
}

/** Nodes, sites and services of an Ansible inventory document. */
export function inventorySize(inv: AnsibleInventory): { nodes: number; sites: number; services: number } {
  const children = (name: string): number => {
    const g = inv[name];
    return g !== undefined && 'children' in g ? (g.children ?? []).length : 0;
  };
  return { nodes: Object.keys(inv._meta.hostvars).length, sites: children(SITE_PARENT), services: children(SERVICE_PARENT) };
}

export function InventoryCard(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const base = restBase();
  const preview = useQuery({
    queryKey: ['inventoryPreview'] as const,
    queryFn: loadPreview,
  });
  const size = preview.data === undefined ? null : inventorySize(preview.data);

  return (
    <section aria-label={t('integrations.inventory.title')}>
      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle as="h2" size="sm" description={t('integrations.inventory.subtitle')}>
          {t('integrations.inventory.title')}
        </SectionTitle>
        {preview.isPending ? (
          <QueryState status="pending" />
        ) : preview.isError || size === null ? (
          <QueryState
            status="error"
            onRetry={() => {
              void preview.refetch();
            }}
          />
        ) : (
          <div className="grid grid-cols-1 gap-om-12 sm:grid-cols-3">
            <Kpi label={t('integrations.inventory.nodes')} value={format.integer(size.nodes)} />
            <Kpi label={t('integrations.inventory.sites')} value={format.integer(size.sites)} />
            <Kpi label={t('integrations.inventory.services')} value={format.integer(size.services)} />
          </div>
        )}
        <div className="overflow-x-auto">
          <table className={tableClass} aria-label={t('integrations.inventory.endpoints')}>
            <caption className="pb-om-6 text-start text-om-2xs text-om-muted">{t('integrations.inventory.endpoints')}</caption>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>
                  {t('integrations.inventory.tool')}
                </th>
                <th scope="col" className={thClass}>
                  {t('integrations.inventory.endpoint')}
                </th>
                <th scope="col" className={thClass}>
                  {t('integrations.inventory.client')}
                </th>
                <th scope="col" className={thClass}>
                  <span className="sr-only">{t('integrations.inventory.download')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {INVENTORY_TOOLS.map((row) => (
                <tr key={row.tool}>
                  <td className={tdClass + ' font-om-display font-semibold'}>{t(toolKey(row.tool))}</td>
                  <td className={tdClass}>
                    <span className="break-all font-om-mono text-om-xs text-om-primary">{base + REST_ROUTES[row.route].path}</span>
                    {row.tool === 'puppet' ? (
                      <span className="block break-all font-om-mono text-om-2xs text-om-muted">{base + REST_ROUTES.puppetNode.path}</span>
                    ) : null}
                  </td>
                  <td className={tdClass}>
                    <span className="block font-om-mono text-om-xs text-om-secondary">{row.client}</span>
                    <code className="block break-all font-om-mono text-om-2xs text-om-muted" dir="ltr">
                      {row.usage}
                    </code>
                  </td>
                  <td className={tdClass}>
                    <Button
                      tone="quiet"
                      onClick={() => {
                        void downloadFromApi(REST_BASE_PATH + REST_ROUTES[row.route].path + row.download, row.file);
                      }}
                    >
                      {t('integrations.inventory.downloadTool', { tool: t(toolKey(row.tool)) })}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-om-xs text-om-secondary">{t('integrations.inventory.token')}</p>
        <p className="text-om-xs text-om-secondary">{t('integrations.inventory.filters')}</p>
      </Card>
    </section>
  );
}
