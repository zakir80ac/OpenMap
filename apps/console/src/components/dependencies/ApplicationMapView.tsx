'use client';
// REQ-DEP-004 (ADR-031) — the layered application map on the Dependencies screen: pick an application, see its tiers
// left to right (web, api, db…), each component with its technology and port, and under it, one row per layer, where
// it runs (VMs, hosts, workloads, cloud resources, and what those run on); layer chips hide rows. The dependency list
// says which component talks to which inside the application and to other applications, with the evidence a
// derived dependency carries (ADR-029). The application and hidden layers live in the URL.
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { CiLayer } from '@openmap/contracts';
import type { Locale } from '@openmap/i18n';
import { BSM } from '@openmap/constants';
import { Card, LayerBadge, Pill, SectionTitle, Tag, layerColor } from '@openmap/ui';
import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { layerKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { applicationMapQuery, type ApplicationDependency, type Placement } from '@/lib/application-map-queries';
import { cisPageQuery, type CiSummary } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';
import { dependencyCounts, placementLayers, placementsByComponent } from './application-layers';

export interface ApplicationMapViewProps {
  locale: Locale;
}

export const APPLICATION_PARAMS = { app: 'app', hidden: 'hide' } as const;

const labelClass = 'text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';
const selectClass =
  'h-10 rounded-om-control-lg border border-om-border-glass bg-om-surface1/80 px-om-10 text-om-sm text-om-primary outline-none focus:border-om-cyan/40';

function ciHref(locale: Locale, ci: CiSummary): string {
  return localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id));
}

export function ApplicationMapView({ locale }: ApplicationMapViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const appId = params.get(APPLICATION_PARAMS.app);
  const hidden = useMemo(() => new Set((params.get(APPLICATION_PARAMS.hidden) ?? '').split(',').filter((l) => l !== '')), [params]);

  const setParams = (changes: Record<string, string | null>): void => {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') query.delete(key);
      else query.set(key, value);
    }
    router.replace(pathname + '?' + query.toString(), { scroll: false });
  };
  const toggleLayer = (layer: CiLayer): void => {
    const next = new Set(hidden);
    if (next.has(layer)) next.delete(layer);
    else next.add(layer);
    setParams({ [APPLICATION_PARAMS.hidden]: [...next].sort().join(',') });
  };

  const applications = useQuery(cisPageQuery({ types: ['application'] }));
  const map = useQuery(applicationMapQuery(appId));
  const placements = useMemo(() => (map.data ? placementsByComponent(map.data) : new Map<string, Placement[]>()), [map.data]);
  const layers = useMemo(() => (map.data ? placementLayers(map.data) : []), [map.data]);
  const counts = map.data ? dependencyCounts(map.data) : null;

  const renderDependency = (d: ApplicationDependency): ReactNode => (
    <li key={d.id} className="flex flex-col gap-om-2 border-b border-om-border-glass py-om-6 text-om-sm last:border-b-0">
      <span className="flex flex-wrap items-center gap-om-6">
        <Link href={ciHref(locale, d.from)} className="text-om-primary hover:text-om-cyan">
          {d.from.displayName}
        </Link>
        <span aria-hidden="true" className="text-om-muted">
          →
        </span>
        <Link href={ciHref(locale, d.to)} className="text-om-primary hover:text-om-cyan">
          {d.to.displayName}
        </Link>
        {d.otherApplication !== null ? <Tag>{d.otherApplication.displayName}</Tag> : null}
      </span>
      <span className="flex flex-wrap gap-x-om-10 text-om-2xs text-om-secondary">
        <span>{t(d.derived ? 'appmap.dep.derived' : 'appmap.dep.asserted', { type: d.type })}</span>
        {d.protocol !== null && d.ports.length > 0 ? (
          <span className="font-om-mono">
            {d.protocol}/{d.ports.map((p) => String(p)).join(',')}
          </span>
        ) : null}
        {d.flows !== null ? <span>{t('appmap.dep.flows', { flows: format.integer(d.flows) })}</span> : null}
        <span>{t('appmap.dep.confidence', { percent: format.integer(Math.round(d.confidence * BSM.percentScale)) })}</span>
      </span>
    </li>
  );

  return (
    <div className="flex flex-col gap-om-16" data-testid="application-map">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('appmap.subtitle')}>
        {t('nav.dependencies')}
      </SectionTitle>
      <Card as="section" padding="16" className="flex flex-col gap-om-12">
        <div role="toolbar" aria-label={t('appmap.toolbar')} className="flex flex-wrap items-end gap-om-16">
          <label className="flex min-w-72 flex-col gap-om-4">
            <span className={labelClass}>{t('appmap.application')}</span>
            <select
              className={selectClass}
              value={appId ?? ''}
              onChange={(event) => {
                setParams({ [APPLICATION_PARAMS.app]: event.target.value });
              }}
            >
              <option value="">{t('appmap.pick')}</option>
              {(applications.data?.items ?? []).map((app) => (
                <option key={app.id} value={app.id}>
                  {app.displayName}
                </option>
              ))}
            </select>
          </label>
          {layers.length > 0 ? (
            <div role="group" aria-label={t('appmap.layers')} className="flex flex-wrap gap-om-6 pb-om-2">
              {layers.map((layer) => (
                <Pill
                  key={layer}
                  selected={!hidden.has(layer)}
                  onClick={() => {
                    toggleLayer(layer);
                  }}
                  icon={<span aria-hidden="true" className="inline-block size-2 rounded-full" style={{ background: layerColor(layer) }} />}
                >
                  {t(layerKey(layer))}
                </Pill>
              ))}
            </div>
          ) : null}
          {map.data ? (
            <span role="status" className="ms-auto pb-om-8 font-om-mono text-om-2xs text-om-secondary">
              {t('appmap.stats', {
                components: format.integer(map.data.tiers.reduce((n, tier) => n + tier.components.length, 0)),
                dependencies: format.integer(map.data.dependencies.length),
                ms: format.integer(map.data.durationMs),
              })}
            </span>
          ) : null}
        </div>
      </Card>

      {appId === null ? (
        <p className="text-om-sm text-om-secondary">{t('appmap.none')}</p>
      ) : map.data === undefined ? (
        <QueryState status={map.isError ? 'error' : 'pending'} onRetry={() => void map.refetch()} />
      ) : map.data === null ? (
        <p role="alert" className="text-om-sm text-om-rose">
          {t('appmap.notApplication')}
        </p>
      ) : (
        <div className="grid gap-om-16 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <Card as="section" padding="16" className="flex min-w-0 flex-col gap-om-12">
            <div className="flex flex-wrap items-center gap-om-8">
              <h2 className="font-om-display text-om-lg font-bold text-om-primary">{map.data.application.displayName}</h2>
              {map.data.services.map((s) => (
                <Link key={s.id} href={ciHref(locale, s)}>
                  <Pill>{s.displayName}</Pill>
                </Link>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-start" aria-label={t('appmap.grid')}>
                <thead>
                  <tr>
                    <th scope="col" className={labelClass + ' w-32 text-start'}>
                      {t('appmap.tier')}
                    </th>
                    {map.data.tiers.map((tier) => (
                      <th key={tier.tier} scope="colgroup" colSpan={tier.components.length} className={labelClass + ' text-start'}>
                        {tier.tier}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" className="align-top">
                      <LayerBadge layer="applications" label={t(layerKey('applications'))} />
                    </th>
                    {map.data.tiers.flatMap((tier) =>
                      tier.components.map((c) => (
                        <td key={c.ci.id} data-testid="appmap-component" className="min-w-48 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-10 align-top">
                          <Link href={ciHref(locale, c.ci)} className="block truncate text-om-sm font-semibold text-om-primary hover:text-om-cyan">
                            {c.ci.displayName}
                          </Link>
                          {c.technology !== null ? <span className="block truncate text-om-2xs text-om-secondary">{c.technology}</span> : null}
                          <span className="flex flex-wrap gap-x-om-8 text-om-2xs text-om-muted">
                            {c.port !== null ? <span className="font-om-mono">{(c.protocol ?? '') + '/' + String(c.port)}</span> : null}
                            {c.instances !== null ? <span>{t('appmap.instances', { count: format.integer(c.instances) })}</span> : null}
                          </span>
                        </td>
                      )),
                    )}
                  </tr>
                  {layers
                    .filter((layer) => !hidden.has(layer))
                    .map((layer) => (
                      <tr key={layer} data-testid={'appmap-layer-' + layer}>
                        <th scope="row" className="align-top">
                          <LayerBadge layer={layer} label={t(layerKey(layer))} />
                        </th>
                        {map.data?.tiers.flatMap((tier) =>
                          tier.components.map((c) => {
                            const here = (placements.get(c.ci.id) ?? []).filter((p) => p.ci.layer === layer);
                            return (
                              <td key={c.ci.id + layer} className="p-om-6 align-top">
                                <ul className="flex flex-col gap-om-2">
                                  {here.map((p) => (
                                    <li key={p.ci.id} className="truncate text-om-2xs">
                                      <Link href={ciHref(locale, p.ci)} className="text-om-secondary hover:text-om-cyan">
                                        {p.ci.displayName}
                                      </Link>
                                    </li>
                                  ))}
                                </ul>
                              </td>
                            );
                          }),
                        )}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {map.data.truncated ? <p className="text-om-2xs text-om-amber">{t('appmap.truncated')}</p> : null}
          </Card>

          <Card as="aside" className="flex flex-col gap-om-12">
            <SectionTitle as="h3" size="sm">
              {t('appmap.dependencies')}
            </SectionTitle>
            {counts !== null ? (
              <p className="text-om-2xs text-om-secondary">
                {t('appmap.counts', { internal: format.integer(counts.internal), outbound: format.integer(counts.outbound), inbound: format.integer(counts.inbound) })}
              </p>
            ) : null}
            {(['internal', 'outbound', 'inbound'] as const).map((direction) => {
              const list = map.data?.dependencies.filter((d) => d.direction === direction) ?? [];
              if (list.length === 0) return null;
              return (
                <section key={direction} aria-label={t(`appmap.direction.${direction}`)} data-testid={'appmap-deps-' + direction}>
                  <h4 className={labelClass}>{t(`appmap.direction.${direction}`)}</h4>
                  <ul className="flex flex-col">{list.map(renderDependency)}</ul>
                </section>
              );
            })}
            <Link
              href={localizedHref(locale, '/dependencies') + '?ci=' + encodeURIComponent(map.data.application.id) + '&direction=downstream'}
              className="mt-auto flex items-center justify-center rounded-om-control-lg bg-om-cyan px-om-12 py-om-8 text-om-sm font-semibold text-om-ground"
            >
              {t('topology.openImpact')}
            </Link>
          </Card>
        </div>
      )}
    </div>
  );
}
