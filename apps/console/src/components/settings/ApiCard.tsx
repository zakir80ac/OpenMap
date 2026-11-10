'use client';
// REQ-CORE-019 REQ-UI-019 (ADR-049) — the API on the Settings screen: the REST, OpenAPI and GraphQL addresses of this
// deployment, every REST route from the live OpenAPI document (method, path, summary, read or write), and how a script
// signs in (the automation client's credentials grant) or uses the SDK.
import { useQuery } from '@tanstack/react-query';
import { REST_BASE_PATH, type RestRouteId } from '@openmap/contracts';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import type { ReactNode } from 'react';
import { tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { graphqlEndpoint } from '@/lib/graphql';
import { useT } from '@/providers';

interface Operation {
  operationId: string;
  summary: string;
  'x-openmap-write': boolean;
}

interface OpenApiDocument {
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
}

const OPENAPI_PATH = '/openapi.json';

/** Each REST route's summary in the user's language; a route the console does not know yet shows the document's text. */
const ROUTE_KEY = {
  listCis: 'settings.api.op.listCis',
  getCi: 'settings.api.op.getCi',
  patchCiAttributes: 'settings.api.op.patchCiAttributes',
  listCiRelationships: 'settings.api.op.listCiRelationships',
  getCiImpact: 'settings.api.op.getCiImpact',
  createRelationship: 'settings.api.op.createRelationship',
  retireRelationship: 'settings.api.op.retireRelationship',
  search: 'settings.api.op.search',
  listIncidents: 'settings.api.op.listIncidents',
  getConnectivity: 'settings.api.op.getConnectivity',
  ansibleInventory: 'settings.api.op.ansibleInventory',
  saltRoster: 'settings.api.op.saltRoster',
  puppetNodes: 'settings.api.op.puppetNodes',
  puppetNode: 'settings.api.op.puppetNode',
  chefExport: 'settings.api.op.chefExport',
} as const satisfies Record<RestRouteId, string>;

/** The REST base of this deployment: the API origin GraphQL is served on, plus REST_BASE_PATH. */
export function restBase(): string {
  return new URL(graphqlEndpoint()).origin + REST_BASE_PATH;
}

export function ApiCard(): ReactNode {
  const t = useT();
  const base = restBase();
  const doc = useQuery({
    queryKey: ['openapi'] as const,
    queryFn: async ({ signal }) => {
      const res = await fetch(base + OPENAPI_PATH, { signal });
      if (!res.ok) throw new Error('openapi ' + String(res.status));
      return (await res.json()) as OpenApiDocument;
    },
  });
  const rows =
    doc.data === undefined
      ? []
      : Object.entries(doc.data.paths).flatMap(([path, ops]) =>
          Object.entries(ops).map(([method, op]) => ({ path, method: method.toUpperCase(), op })),
        );

  return (
    <section aria-label={t('settings.api.title')}>
      <Card padding="24" className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm" description={t('settings.api.subtitle')}>
          {t('settings.api.title')}
        </SectionTitle>
        <dl className="grid gap-om-8 md:grid-cols-3">
          {[
            [t('settings.api.rest'), base],
            [t('settings.api.openapi'), base + OPENAPI_PATH],
            [t('settings.api.graphql'), graphqlEndpoint()],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-om-2">
              <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{label}</dt>
              <dd className="break-all font-om-mono text-om-xs text-om-primary">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-om-xs text-om-secondary">{t('settings.api.auth')}</p>
        <p className="text-om-xs text-om-secondary">{t('settings.api.sdk')}</p>
        {doc.isPending ? (
          <QueryState status="pending" />
        ) : doc.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void doc.refetch();
            }}
          />
        ) : (
          <div className="overflow-x-auto">
            <table
              className={tableClass}
              aria-label={t('settings.api.routes', { version: doc.data.info.version })}
            >
              <caption className="pb-om-6 text-start text-om-2xs text-om-muted">
                {t('settings.api.routes', { version: doc.data.info.version })}
              </caption>
              <thead className={theadClass}>
                <tr>
                  <th scope="col" className={thClass}>
                    {t('settings.api.method')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('settings.api.path')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('settings.api.summary')}
                  </th>
                  <th scope="col" className={thClass}>
                    {t('settings.api.access')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.method + r.path}>
                    <td className={tdClass}>
                      <span className="font-om-mono">{r.method}</span>
                    </td>
                    <td className={tdClass}>
                      <span className="font-om-mono">{r.path}</span>
                    </td>
                    <td className={tdClass}>
                      {r.op.operationId in ROUTE_KEY
                        ? t(ROUTE_KEY[r.op.operationId as RestRouteId])
                        : r.op.summary}
                    </td>
                    <td className={tdClass}>
                      <Tag>{r.op['x-openmap-write'] ? t('settings.api.write') : t('settings.api.read')}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
