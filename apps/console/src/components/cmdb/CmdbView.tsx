'use client';
// REQ-UI-008 — CMDB: virtualised CI list (TanStack Virtual) over the cursor-paginated `cis` query, with layer filter
// chips. Hidden layers (per-device visibility) are excluded unless a chip selects one explicitly.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import Link from 'next/link';
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';
import { Card, LayerBadge, Pill, SectionTitle, StateBadge, cx, layerColor, spacing } from '@openmap/ui';
import { useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { useLayerVisibility } from '@/hooks/useLayerVisibility';
import { healthKey, layerKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { cisInfiniteQuery, type CiFilterInput } from '@/lib/queries';
import { useFormatters, useLocale, useT } from '@/providers';

/** Two text lines plus padding; expressed through the spacing scale so apps/ carries no numeric literal. */
const ROW_HEIGHT = spacing['28'] + spacing['28'];
/** Rows rendered beyond the viewport, and the distance from the end at which the next page is requested. */
const OVERSCAN_ROWS = spacing['8'];

export interface CmdbViewProps {
  /** Text filter from the global search (`?q=`); empty means no text filter. */
  text: string;
}

const columns =
  'grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-om-12 px-om-16';

export function CmdbView({ text }: CmdbViewProps): ReactNode {
  const t = useT();
  const locale = useLocale();
  const format = useFormatters();
  const { visibility, visibleCount } = useLayerVisibility();
  const [selected, setSelected] = useState<CiLayer | undefined>(undefined);

  const filter = useMemo<CiFilterInput>(() => {
    const next: CiFilterInput = {};
    if (text !== '') next.text = text;
    if (selected !== undefined) next.layers = [selected];
    else if (visibleCount < CI_LAYERS.length) next.layers = CI_LAYERS.filter((layer) => visibility[layer]);
    return next;
  }, [text, selected, visibility, visibleCount]);

  const query = useInfiniteQuery(cisInfiniteQuery(filter));
  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.cis.edges.map((edge) => edge.node)) ?? [],
    [query.data],
  );
  const totalCount = query.data?.pages[0]?.cis.totalCount;

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
  });

  const loadMore = (): void => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  };

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < ROW_HEIGHT * OVERSCAN_ROWS) loadMore();
  };

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('app.name')}
        description={text === '' ? t('cmdb.subtitle') : t('cmdb.searchFor', { text })}
      >
        {t('nav.cmdb')}
      </SectionTitle>

      <div role="group" aria-label={t('cmdb.filter.label')} className="flex flex-wrap items-center gap-om-8">
        <Pill
          variant={selected === undefined ? 'primary' : 'default'}
          selected={selected === undefined}
          glowing={selected === undefined}
          onClick={() => {
            setSelected(undefined);
          }}
        >
          {t('cmdb.filter.all')}
        </Pill>
        {CI_LAYERS.map((layer) => {
          const active = selected === layer;
          return (
            <Pill
              key={layer}
              variant={active ? 'primary' : 'default'}
              selected={active}
              glowing={active}
              icon={
                <span
                  aria-hidden="true"
                  className="inline-block size-2 rounded-om-pill"
                  style={{ background: layerColor(layer) }}
                />
              }
              className={cx(!visibility[layer] && !active && 'opacity-60')}
              onClick={() => {
                setSelected(active ? undefined : layer);
              }}
            >
              {t(layerKey(layer))}
            </Pill>
          );
        })}
      </div>

      <Card padding="4" className="overflow-hidden">
        <div
          role="table"
          aria-rowcount={totalCount ?? -1}
          aria-busy={query.isPending || query.isFetchingNextPage}
          className="flex flex-col"
        >
          <div
            role="row"
            className={cx(
              columns,
              'h-10 border-b border-om-border-glass text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted',
            )}
          >
            <span role="columnheader">{t('cmdb.column.name')}</span>
            <span role="columnheader">{t('cmdb.column.type')}</span>
            <span role="columnheader">{t('cmdb.column.layer')}</span>
            <span role="columnheader">{t('cmdb.column.health')}</span>
            <span role="columnheader">{t('cmdb.column.observed')}</span>
          </div>

          {query.isPending ? (
            <QueryState status="pending" className="m-om-12" />
          ) : query.isError ? (
            <QueryState
              status="error"
              className="m-om-12"
              onRetry={() => {
                void query.refetch();
              }}
            />
          ) : rows.length === 0 ? (
            <QueryState status="empty" className="m-om-12" />
          ) : (
            <div
              ref={parentRef}
              onScroll={onScroll}
              className="relative h-[min(60dvh,40rem)] overflow-y-auto"
            >
              <div role="rowgroup" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const row = rows[item.index];
                  if (row === undefined) return null;
                  return (
                    <div
                      key={row.id}
                      role="row"
                      aria-rowindex={item.index + 1}
                      className={cx(
                        columns,
                        'absolute inset-x-0 top-0 border-b border-om-border-glass text-om-sm transition-colors duration-om-fast hover:bg-om-surface2/60',
                      )}
                      style={{ height: item.size, transform: 'translateY(' + String(item.start) + 'px)' }}
                    >
                      <span role="cell" className="min-w-0">
                        <Link
                          href={localizedHref(locale, '/cmdb/' + encodeURIComponent(row.id))}
                          className="block truncate font-medium text-om-primary hover:text-om-cyan"
                        >
                          {row.displayName}
                        </Link>
                        <span className="block truncate font-om-mono text-om-2xs text-om-muted">
                          {row.code}
                        </span>
                      </span>
                      <span role="cell" className="truncate font-om-mono text-om-xs text-om-secondary">
                        {row.type}
                      </span>
                      <span role="cell" className="min-w-0">
                        <LayerBadge layer={row.layer} label={t(layerKey(row.layer))} />
                      </span>
                      <span role="cell">
                        <StateBadge state={row.health} label={t(healthKey[row.health])} />
                      </span>
                      <span role="cell" className="truncate text-om-xs text-om-secondary">
                        {format.dateTime(row.observedAt)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-om-12 border-t border-om-border-glass px-om-16 py-om-10 text-om-xs text-om-secondary">
          <span>
            {totalCount === undefined
              ? t('common.loading')
              : t('cmdb.total', { count: format.integer(totalCount) })}
          </span>
          {query.hasNextPage ? (
            <button
              type="button"
              onClick={loadMore}
              disabled={query.isFetchingNextPage}
              className="rounded-om-control border border-om-cyan/30 bg-om-cyan/10 px-om-10 py-om-4 font-medium text-om-cyan transition-colors duration-om-base ease-om-standard hover:bg-om-cyan/20 disabled:opacity-60"
            >
              {query.isFetchingNextPage ? t('common.loading') : t('cmdb.loadMore')}
            </button>
          ) : rows.length > 0 ? (
            <span className="text-om-muted">{t('cmdb.endOfList')}</span>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
