'use client';
// REQ-UI-007 REQ-DEP-003 REQ-DEP-005 — Dependency map screen: focus picker, direction, depth (bounded by
// GRAPH.maxImpactDepth), time travel (`asOf`), lane toggles per layer, the Sigma.js canvas with lane layout from a
// Web Worker, hover tooltips, click-through to the CI detail, and the impact side panel. State lives in the URL so a
// map can be linked from anywhere (`/dependencies?ci=…&direction=…&depth=…&asOf=…`).
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { DEPENDENCY_MAP, GRAPH } from '@openmap/constants';
import { CI_LAYERS } from '@openmap/contracts';
import type { Locale } from '@openmap/i18n';
import { Card, LayerBadge, Pill, SectionTitle, StateBadge, Tag, cx, layerColor } from '@openmap/ui';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { useLayerVisibility } from '@/hooks/useLayerVisibility';
import {
  RELATIONSHIP_FAMILIES,
  buildImpactGraph,
  predictedColor,
  relationshipFamilyColor,
  type LayoutRequest,
  type MapNode,
} from '@/lib/graph-layout';
import { healthKey, layerKey, predictedKey, relationshipFamilyKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { ciDetailQuery, impactQuery, type CiSummary, type ImpactDirection } from '@/lib/queries';
import { toAsOf, toLocalInput } from '@/lib/time-travel';
import { useFormatters, useT } from '@/providers';
import { DependencyCanvas, type HoverInfo } from './DependencyCanvas';
import { FocusSearch } from './FocusSearch';
import { ImpactPanel } from './ImpactPanel';
import { useLaneLayout } from './useLaneLayout';

export interface DependenciesViewProps {
  locale: Locale;
  ciId: string | undefined;
  direction: ImpactDirection;
  depth: number;
  /** ISO timestamp or undefined for now. */
  asOf: string | undefined;
}

const DIRECTIONS: readonly ImpactDirection[] = ['upstream', 'downstream', 'both'];
const DEPTHS: readonly number[] = Array.from({ length: GRAPH.maxImpactDepth }, (_, index) => index + 1);
const PREDICTED = ['down', 'degraded', 'at_risk', 'unaffected'] as const;

export function isImpactDirection(value: string | undefined): value is ImpactDirection {
  return value !== undefined && (DIRECTIONS as readonly string[]).includes(value);
}

/** Depth from a query string or select value: integers 1..maxImpactDepth; anything else is the default. */
export function parseDepth(value: string | undefined): number {
  const parsed = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > GRAPH.maxImpactDepth) return GRAPH.defaultImpactDepth;
  return parsed;
}

export function DependenciesView({ locale, ciId, direction, depth, asOf }: DependenciesViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const router = useRouter();
  const { visibility, toggle, showAll, visibleCount } = useLayerVisibility();
  const [hover, setHover] = useState<HoverInfo | undefined>(undefined);
  const requestCounter = useRef(0);

  const impact = useQuery({ ...impactQuery({ ciId: ciId ?? '', direction, maxDepth: depth, asOf: asOf ?? null }), enabled: ciId !== undefined });
  const focusDetail = useQuery({ ...ciDetailQuery(ciId ?? '', asOf ?? null), enabled: ciId !== undefined });

  const graph = useMemo(() => (impact.data === undefined ? undefined : buildImpactGraph(impact.data, visibility)), [impact.data, visibility]);

  const layoutRequest = useMemo<LayoutRequest | undefined>(() => {
    if (graph === undefined || impact.data === undefined) return undefined;
    requestCounter.current += 1;
    return {
      requestId: requestCounter.current,
      rootId: impact.data.root.id,
      nodes: graph.nodes.map((n) => ({ id: n.id, layer: n.layer, depth: n.depth, label: n.label })),
    };
  }, [graph, impact.data]);
  const layout = useLaneLayout(layoutRequest);

  const relationships = useMemo(() => focusDetail.data?.relationships.edges.map((edge) => edge.node) ?? [], [focusDetail.data]);

  /** Edges touching the focus CI whose relationship type is known take the family colour of that type. */
  const edgeTypes = useMemo(() => {
    const map = new Map<string, string>();
    for (const rel of relationships) {
      map.set(rel.from.id + '→' + rel.to.id, rel.type);
      map.set(rel.to.id + '→' + rel.from.id, rel.type);
    }
    return map;
  }, [relationships]);

  const navigate = (next: { ciId?: string | undefined; direction?: ImpactDirection; depth?: number; asOf?: string | undefined }): void => {
    const params = new URLSearchParams();
    const id = 'ciId' in next ? next.ciId : ciId;
    const dir = next.direction ?? direction;
    const d = next.depth ?? depth;
    const at = 'asOf' in next ? next.asOf : asOf;
    if (id !== undefined) params.set('ci', id);
    if (dir !== 'upstream') params.set('direction', dir);
    if (d !== GRAPH.defaultImpactDepth) params.set('depth', String(d));
    if (at !== undefined) params.set('asOf', at);
    const query = params.toString();
    router.replace(localizedHref(locale, '/dependencies') + (query === '' ? '' : '?' + query));
  };

  const openCi = (node: MapNode): void => {
    router.push(localizedHref(locale, '/cmdb/' + encodeURIComponent(node.id)));
  };

  const focus: CiSummary | undefined = impact.data?.root ?? focusDetail.data ?? undefined;
  const timeTravelling = asOf !== undefined;

  return (
    <div className="flex flex-col gap-om-20">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('app.name')}
        description={focus === undefined ? t('dependencies.subtitle') : t('dependencies.focusOn', { name: focus.displayName })}
        action={
          <Pill variant={timeTravelling ? 'time-travel' : 'primary'} glowing>
            {timeTravelling ? t('dependencies.asOf.label') + ' · ' + format.dateTime(asOf) : t('dependencies.asOf.now')}
          </Pill>
        }
      >
        {t('nav.dependencies')}
      </SectionTitle>

      <Card as="section" padding="16" className="flex flex-col gap-om-12">
        <div role="toolbar" aria-label={t('dependencies.toolbar')} className="grid grid-cols-1 gap-om-12 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,1fr)]">
          <FocusSearch
            current={focus}
            onPick={(ci) => {
              navigate({ ciId: ci.id });
            }}
          />
          <label className="flex flex-col gap-om-4">
            <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('dependencies.direction.label')}</span>
            <select
              value={direction}
              onChange={(event) => {
                const value = event.target.value;
                if (isImpactDirection(value)) navigate({ direction: value });
              }}
              className="h-10 rounded-om-control-lg border border-om-border-glass bg-om-surface1/80 px-om-10 text-om-sm text-om-primary outline-none focus:border-om-cyan/40 focus:shadow-om-glow-bar-cyan"
            >
              {DIRECTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`dependencies.direction.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-om-4">
            <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('dependencies.depth.label')}</span>
            <select
              value={depth}
              onChange={(event) => {
                navigate({ depth: parseDepth(event.target.value) });
              }}
              className="h-10 rounded-om-control-lg border border-om-border-glass bg-om-surface1/80 px-om-10 text-om-sm text-om-primary outline-none focus:border-om-cyan/40 focus:shadow-om-glow-bar-cyan"
            >
              {DEPTHS.map((value) => (
                <option key={value} value={value}>
                  {t('common.hops', { count: format.integer(value) })}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-om-4">
            <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('dependencies.asOf.label')}</span>
            <span className="flex items-center gap-om-6">
              <input
                type="datetime-local"
                value={toLocalInput(asOf)}
                onChange={(event) => {
                  navigate({ asOf: toAsOf(event.target.value) });
                }}
                className={cx(
                  'h-10 min-w-0 flex-1 rounded-om-control-lg border bg-om-surface1/80 px-om-10 text-om-sm text-om-primary outline-none focus:shadow-om-glow-bar-violet',
                  timeTravelling ? 'border-om-violet/50' : 'border-om-border-glass focus:border-om-violet/40',
                )}
              />
              {timeTravelling ? (
                <Pill
                  variant="violet"
                  onClick={() => {
                    navigate({ asOf: undefined });
                  }}
                >
                  {t('dependencies.asOf.clear')}
                </Pill>
              ) : null}
            </span>
          </label>
        </div>

        <div role="group" aria-label={t('dependencies.lanes.label')} className="flex flex-wrap items-center gap-om-6">
          {CI_LAYERS.map((layer) => {
            const on = visibility[layer];
            return (
              <Pill
                key={layer}
                variant={on ? 'primary' : 'default'}
                selected={on}
                glowing={false}
                icon={<span aria-hidden="true" className="inline-block size-2 rounded-om-pill" style={{ background: layerColor(layer) }} />}
                className={cx(!on && 'opacity-60')}
                onClick={() => {
                  toggle(layer);
                }}
              >
                {t(layerKey(layer))}
              </Pill>
            );
          })}
          {visibleCount < CI_LAYERS.length ? (
            <Pill variant="violet" onClick={showAll}>
              {t('dependencies.lanes.showAll')}
            </Pill>
          ) : null}
        </div>
      </Card>

      {ciId === undefined ? (
        <Card>
          <QueryState status="empty" />
          <p className="mt-om-10 text-om-sm text-om-secondary">{t('dependencies.focus.none')}</p>
        </Card>
      ) : impact.isPending ? (
        <Card>
          <QueryState status="pending" />
        </Card>
      ) : impact.isError ? (
        <Card>
          <QueryState
            status="error"
            onRetry={() => {
              void impact.refetch();
            }}
          />
        </Card>
      ) : graph === undefined ? null : (
        <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,22rem)]">
          <div className="relative flex min-h-[40rem] flex-col">
            {graph.nodes.length <= 1 ? (
              <Card className="flex-1">
                <QueryState status="empty" />
                <p className="mt-om-10 text-om-sm text-om-secondary">{t('dependencies.empty', { name: impact.data.root.displayName, count: format.integer(depth) })}</p>
              </Card>
            ) : layout === undefined ? (
              <Card className="flex-1">
                <QueryState status="pending" />
              </Card>
            ) : (
              <>
                <DependencyCanvas
                  graph={graph}
                  positions={layout.positions}
                  lanes={layout.lanes}
                  edgeTypes={edgeTypes}
                  rootId={impact.data.root.id}
                  label={t('dependencies.canvas.label', { name: impact.data.root.displayName })}
                  onHover={setHover}
                  onSelect={openCi}
                  className="min-h-[40rem] flex-1"
                />
                {hover !== undefined ? (
                  <div
                    role="tooltip"
                    className="pointer-events-none absolute z-10 flex max-w-xs flex-col gap-om-4 rounded-om-panel border border-om-border-strong bg-om-surface2/95 p-om-10 text-om-xs shadow-om-card backdrop-blur-md"
                    style={{ insetInlineStart: hover.x + DEPENDENCY_MAP.tooltipOffsetPx, top: hover.y + DEPENDENCY_MAP.tooltipOffsetPx }}
                  >
                    <span className="truncate font-om-display text-om-sm font-bold text-om-primary">{hover.node.label}</span>
                    <span className="font-om-mono text-om-2xs text-om-muted">{hover.node.type}</span>
                    <span className="flex flex-wrap items-center gap-om-6">
                      <LayerBadge layer={hover.node.layer} label={t(layerKey(hover.node.layer))} />
                      <StateBadge state={hover.node.health} label={t(healthKey[hover.node.health])} />
                      <Tag>{t(predictedKey[hover.node.predicted])}</Tag>
                    </span>
                    <span className="text-om-2xs text-om-secondary">{t('common.hops', { count: format.integer(hover.node.depth) })}</span>
                    <span className="text-om-2xs text-om-cyan">{t('dependencies.nodeAction', { name: hover.node.label })}</span>
                  </div>
                ) : null}
                <div className="pointer-events-none absolute bottom-om-16 start-om-16 flex flex-col gap-om-6 rounded-om-panel border border-om-border-strong bg-om-surface1/85 p-om-10 text-om-2xs text-om-secondary backdrop-blur-md" aria-label={t('dependencies.legend.title')}>
                  <span className="font-semibold text-om-muted">{t('dependencies.legend.predicted')}</span>
                  <span className="flex flex-wrap gap-om-8">
                    {PREDICTED.map((state) => (
                      <span key={state} className="flex items-center gap-om-4">
                        <span aria-hidden="true" className="inline-block h-px w-4" style={{ background: predictedColor(state) }} />
                        {t(predictedKey[state])}
                      </span>
                    ))}
                  </span>
                  <span className="font-semibold text-om-muted">{t('dependencies.legend.relationship')}</span>
                  <span className="flex flex-wrap gap-om-8">
                    {RELATIONSHIP_FAMILIES.map((family) => (
                      <span key={family} className="flex items-center gap-om-4">
                        <span aria-hidden="true" className="inline-block size-2 rounded-om-pill" style={{ background: relationshipFamilyColor[family] }} />
                        {t(relationshipFamilyKey(family))}
                      </span>
                    ))}
                  </span>
                </div>
                <p role="status" className="pointer-events-none absolute end-om-16 top-om-16 rounded-om-panel border border-om-border-strong bg-om-surface1/85 px-om-10 py-om-6 font-om-mono text-om-2xs text-om-secondary backdrop-blur-md">
                  {t('dependencies.hud.stats', {
                    nodes: format.integer(graph.nodes.length),
                    edges: format.integer(graph.edges.length),
                    query: format.integer(impact.data.durationMs),
                    layout: format.integer(Math.round(layout.durationMs)),
                  })}
                </p>
              </>
            )}
          </div>
          <ImpactPanel locale={locale} result={impact.data} graph={graph} relationships={relationships} />
        </div>
      )}
    </div>
  );
}
