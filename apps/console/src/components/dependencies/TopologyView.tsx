'use client';
// REQ-DEP-001 (ADR-030) — network topology map on the Dependencies screen: L2 draws devices joined by their LLDP/CDP
// neighbour links (hosts attached by their cabling on request), L3 draws devices joined to the subnets their
// addresses sit in; a site narrows the map. The map uses the same Sigma canvas and force layout worker as the impact
// map; clicking a node lists its links (interface pairs, speed, protocols), double-clicking opens the CI, and the
// panel opens the node's impact map. The layer, site and host toggle live in the URL.
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { TOPOLOGY } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Card, LayerBadge, Segmented, SectionTitle, Tag } from '@openmap/ui';
import Link from 'next/link';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { forceLayoutAvailable, relationshipColor, type LayoutRequest, type MapNode } from '@/lib/graph-layout';
import { layerKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { cisPageQuery } from '@/lib/queries';
import { topologyQuery, type TopologyLayer } from '@/lib/topology-queries';
import { useFormatters, useT } from '@/providers';
import { DependencyCanvas, type HoverInfo } from './DependencyCanvas';
import { LINK_RELATIONSHIP, linksOf, topologyGraph } from './topology-graph';
import { useLaneLayout } from './useLaneLayout';

export interface TopologyViewProps {
  locale: Locale;
}

export const TOPOLOGY_PARAMS = { layer: 'tlayer', site: 'site', hosts: 'hosts' } as const;
const HOSTS_ON = '1';

export function parseTopologyLayer(value: string | null): TopologyLayer {
  return (TOPOLOGY.layers as readonly string[]).includes(value ?? '') ? (value as TopologyLayer) : 'l2';
}

const selectClass =
  'h-10 rounded-om-control-lg border border-om-border-glass bg-om-surface1/80 px-om-10 text-om-sm text-om-primary outline-none focus:border-om-cyan/40';
const labelClass = 'text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted';

export function TopologyView({ locale }: TopologyViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const layer = parseTopologyLayer(params.get(TOPOLOGY_PARAMS.layer));
  const siteId = params.get(TOPOLOGY_PARAMS.site);
  const includeHosts = layer === 'l2' && params.get(TOPOLOGY_PARAMS.hosts) === HOSTS_ON;
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [hover, setHover] = useState<HoverInfo | undefined>(undefined);
  const counter = useRef(0);

  const setParam = (key: string, value: string | null): void => {
    const query = new URLSearchParams(params.toString());
    if (value === null) query.delete(key);
    else query.set(key, value);
    setSelectedId(undefined);
    router.replace(pathname + '?' + query.toString(), { scroll: false });
  };

  const sites = useQuery(cisPageQuery({ types: ['site'] }));
  const topology = useQuery(topologyQuery({ layer, siteId, includeHosts }));
  const mapped = useMemo(() => (topology.data === undefined ? undefined : topologyGraph(topology.data)), [topology.data]);
  const layoutRequest = useMemo<LayoutRequest | undefined>(() => {
    if (mapped === undefined) return undefined;
    counter.current += 1;
    const nodes = mapped.graph.nodes;
    return {
      requestId: counter.current,
      rootId: nodes[0]?.id ?? '',
      mode: forceLayoutAvailable(nodes.length) ? 'force' : 'lane',
      seed: 'circle',
      nodes: nodes.map((n) => ({ id: n.id, layer: n.layer, depth: n.depth, label: n.label })),
      edges: mapped.graph.edges.map((e) => ({ source: e.source, target: e.target })),
    };
  }, [mapped]);
  const layout = useLaneLayout(layoutRequest);
  const selected = topology.data?.nodes.find((n) => n.ci.id === selectedId);
  const selectedLinks = topology.data === undefined || selectedId === undefined ? [] : linksOf(topology.data, selectedId);
  const highlight = useMemo(
    () => (selectedId === undefined ? undefined : new Set([selectedId, ...selectedLinks.map((l) => l.other.id)])),
    [selectedId, selectedLinks],
  );

  return (
    <div className="flex flex-col gap-om-16" data-testid="topology-view">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('topology.subtitle')}>
        {t('nav.dependencies')}
      </SectionTitle>
      <Card as="section" padding="16" className="flex flex-col gap-om-12">
        <div role="toolbar" aria-label={t('topology.toolbar')} className="flex flex-wrap items-end gap-om-16">
          <div className="flex flex-col gap-om-4">
            <span className={labelClass}>{t('topology.layer.label')}</span>
            <Segmented
              label={t('topology.layer.label')}
              value={layer}
              options={TOPOLOGY.layers.map((value) => ({ value, label: t(`topology.layer.${value}`) }))}
              onChange={(value) => {
                setParam(TOPOLOGY_PARAMS.layer, value === 'l2' ? null : value);
              }}
            />
          </div>
          <label className="flex min-w-56 flex-col gap-om-4">
            <span className={labelClass}>{t('topology.site.label')}</span>
            <select
              className={selectClass}
              value={siteId ?? ''}
              onChange={(event) => {
                setParam(TOPOLOGY_PARAMS.site, event.target.value === '' ? null : event.target.value);
              }}
            >
              <option value="">{t('topology.site.all')}</option>
              {(sites.data?.items ?? []).map((site) => (
                <option key={site.id} value={site.id}>
                  {site.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-om-8 pb-om-8 text-om-sm text-om-secondary">
            <input
              type="checkbox"
              checked={includeHosts}
              disabled={layer !== 'l2'}
              onChange={(event) => {
                setParam(TOPOLOGY_PARAMS.hosts, event.target.checked ? HOSTS_ON : null);
              }}
            />
            {t('topology.hosts')}
          </label>
          {topology.data !== undefined ? (
            <span role="status" className="ms-auto pb-om-8 font-om-mono text-om-2xs text-om-secondary">
              {t('topology.stats', {
                nodes: format.integer(topology.data.nodes.length),
                links: format.integer(topology.data.links.length),
                ms: format.integer(topology.data.durationMs),
              })}
            </span>
          ) : null}
        </div>
        {topology.data?.truncated === true ? (
          <p className="text-om-2xs text-om-amber">{t('topology.truncated', { max: format.integer(TOPOLOGY.maxNodes) })}</p>
        ) : null}
      </Card>

      <div className="grid gap-om-16 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="relative flex min-h-[40rem] flex-col overflow-hidden rounded-om-panel border border-om-border-glass bg-om-surface1/60">
          {topology.data === undefined || mapped === undefined ? (
            <QueryState status={topology.isError ? 'error' : 'pending'} onRetry={() => void topology.refetch()} className="m-auto" />
          ) : topology.data.nodes.length === 0 ? (
            <p className="m-auto p-om-24 text-om-sm text-om-secondary">{t('topology.empty')}</p>
          ) : layout === undefined ? (
            <p role="status" className="m-auto text-om-sm text-om-secondary">
              {t('topology.laying')}
            </p>
          ) : (
            <>
              <DependencyCanvas
                graph={mapped.graph}
                positions={layout.positions}
                lanes={layout.lanes}
                edgeTypes={mapped.edgeTypes}
                rootId={selectedId ?? ''}
                highlight={highlight}
                label={t('topology.canvas', { layer: t(`topology.layer.${layer}`) })}
                onHover={setHover}
                onSelect={(node: MapNode) => {
                  setSelectedId((current) => (current === node.id ? undefined : node.id));
                }}
                onOpen={(node: MapNode) => {
                  router.push(localizedHref(locale, '/cmdb/' + encodeURIComponent(node.id)));
                }}
                className="min-h-[40rem] flex-1"
              />
              {hover !== undefined ? (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute z-10 flex max-w-xs flex-col gap-om-4 rounded-om-panel border border-om-border-strong bg-om-surface2/95 p-om-10 text-om-xs shadow-om-card"
                  style={{ insetInlineStart: hover.x, top: hover.y }}
                >
                  <span className="truncate font-om-display text-om-sm font-bold text-om-primary">{hover.node.label}</span>
                  <span className="font-om-mono text-om-2xs text-om-muted">{hover.node.type}</span>
                </div>
              ) : null}
              <div
                className="pointer-events-none absolute bottom-om-16 start-om-16 flex flex-wrap gap-om-10 rounded-om-panel border border-om-border-strong bg-om-surface1/85 p-om-10 text-om-2xs text-om-secondary"
                aria-label={t('dependencies.legend.title')}
              >
                {(layer === 'l2' ? (['neighbour', 'host'] as const) : (['subnet'] as const)).map((kind) => (
                  <span key={kind} className="flex items-center gap-om-4">
                    <span aria-hidden="true" className="inline-block h-px w-4" style={{ background: relationshipColor(LINK_RELATIONSHIP[kind]) }} />
                    {t(`topology.kind.${kind}`)}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        <Card as="aside" className="flex flex-col gap-om-12">
          {selected === undefined ? (
            <p className="text-om-sm text-om-secondary">{t('topology.pick')}</p>
          ) : (
            <>
              <div className="flex flex-col gap-om-4">
                <p className={labelClass}>{selected.ci.type}</p>
                <h2 className="truncate font-om-display text-om-lg font-bold text-om-primary">{selected.ci.displayName}</h2>
                <span className="flex items-center gap-om-8">
                  <LayerBadge layer={selected.ci.layer} label={t(layerKey(selected.ci.layer))} />
                  <Tag>{t('topology.degree', { count: format.integer(selected.degree) })}</Tag>
                </span>
              </div>
              <SectionTitle as="h3" size="sm">
                {t('topology.links')}
              </SectionTitle>
              <ul className="flex flex-col" data-testid="topology-links">
                {selectedLinks.map((link) => (
                  <li key={link.id} className="flex flex-col gap-om-2 border-b border-om-border-glass py-om-6 text-om-sm last:border-b-0">
                    <span className="flex items-center gap-om-8">
                      <span aria-hidden="true" className="inline-block size-2 shrink-0 rounded-om-pill" style={{ background: relationshipColor(LINK_RELATIONSHIP[link.kind]) }} />
                      <span className="min-w-0 flex-1 truncate text-om-primary">{link.other.displayName}</span>
                      <span className="shrink-0 text-om-2xs text-om-muted">{t(`topology.kind.${link.kind}`)}</span>
                    </span>
                    <span className="ps-4 font-om-mono text-om-2xs text-om-secondary">{link.ports.join(' · ')}</span>
                    <span className="flex flex-wrap gap-x-om-10 ps-4 text-om-2xs text-om-secondary">
                      {link.speedMbps !== null ? <span>{t('topology.speed', { mbps: format.integer(link.speedMbps) })}</span> : null}
                      {link.protocols.length > 0 ? <span>{link.protocols.join(', ').toUpperCase()}</span> : null}
                      {link.media.length > 0 ? <span>{link.media.join(', ')}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                href={localizedHref(locale, '/dependencies') + '?ci=' + encodeURIComponent(selected.ci.id) + '&direction=both'}
                className="mt-auto flex items-center justify-center rounded-om-control-lg bg-om-cyan px-om-12 py-om-8 text-om-sm font-semibold text-om-ground"
              >
                {t('topology.openImpact')}
              </Link>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
