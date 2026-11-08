'use client';
// REQ-UI-027 — Health and telemetry: the fleet table. Every CI with a latest CPU, memory, IOPS, throughput or Apdex
// sample (ClickHouse), with its category and site, address and health (graph), filtered by health and category and
// by text, sorted by any measure, health or name, and virtualised (TanStack Virtual) over offset pages of the
// `telemetryFleet` query. The API answers from a per-tenant snapshot; the table refreshes on the same period.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import Link from 'next/link';
import { TELEMETRY } from '@openmap/constants';
import type { CiLayer, FleetSort } from '@openmap/contracts';
import { Card, LayerBadge, Pill, SectionTitle, StateBadge, cx, layerColor, spacing } from '@openmap/ui';
import { useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { healthKey, layerKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { fleetInfiniteQuery, type FleetFilterInput, type FleetHealth, type FleetRow } from '@/lib/telemetry-queries';
import { useFormatters, useLocale, useT } from '@/providers';

/** Two text lines plus padding, through the spacing scale so apps/ carries no numeric literal. */
const ROW_HEIGHT = spacing['28'] + spacing['28'];
/** Rows rendered beyond the viewport, and the distance from the end at which the next page is requested. */
const OVERSCAN_ROWS = spacing['8'];

/** The layers whose CIs report a fleet measure. */
const CATEGORIES: readonly CiLayer[] = ['hardware', 'virtualization', 'containers', 'network_security', 'storage', 'databases', 'applications'];
const HEALTHS: readonly FleetHealth[] = ['down', 'degraded', 'unknown', 'healthy'];

const COLUMNS: ReadonlyArray<{ key: FleetSort | null; label: 'telemetry.column.ci' | 'telemetry.column.category' | 'telemetry.column.address' | 'telemetry.column.health' | 'telemetry.column.cpu' | 'telemetry.column.memory' | 'telemetry.column.iops' | 'telemetry.column.throughput' | 'telemetry.column.apdex' }> = [
  { key: 'name', label: 'telemetry.column.ci' },
  { key: null, label: 'telemetry.column.category' },
  { key: null, label: 'telemetry.column.address' },
  { key: 'health', label: 'telemetry.column.health' },
  { key: 'cpu', label: 'telemetry.column.cpu' },
  { key: 'memory', label: 'telemetry.column.memory' },
  { key: 'iops', label: 'telemetry.column.iops' },
  { key: 'throughput', label: 'telemetry.column.throughput' },
  { key: 'apdex', label: 'telemetry.column.apdex' },
];

const grid =
  'grid grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.4fr)_minmax(0,1fr)_repeat(5,minmax(0,0.8fr))] items-center gap-om-10 px-om-16';
const inputClass =
  'h-9 min-w-56 rounded-om-control-lg border border-om-border-glass bg-om-surface1/80 px-om-10 text-om-sm text-om-primary';

function apdexState(apdex: number): 'healthy' | 'degraded' | 'down' {
  if (apdex >= TELEMETRY.apdexGood) return 'healthy';
  return apdex >= TELEMETRY.apdexPoor ? 'degraded' : 'down';
}

export function TelemetryView(): ReactNode {
  const t = useT();
  const locale = useLocale();
  const format = useFormatters();
  const [category, setCategory] = useState<CiLayer | undefined>(undefined);
  const [health, setHealth] = useState<readonly FleetHealth[]>([]);
  const [text, setText] = useState('');
  const [sort, setSort] = useState<FleetSort>('health');

  const filter = useMemo<FleetFilterInput>(() => {
    const next: FleetFilterInput = {};
    if (category !== undefined) next.layers = [category];
    if (health.length > 0) next.health = [...health];
    if (text.trim() !== '') next.text = text.trim();
    return next;
  }, [category, health, text]);

  const query = useInfiniteQuery(fleetInfiniteQuery(filter, sort));
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.telemetryFleet.items) ?? [], [query.data]);
  const first = query.data?.pages[0]?.telemetryFleet;

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
    if (el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * OVERSCAN_ROWS) loadMore();
  };

  const percent = (v: number | null): string => (v === null ? t('telemetry.none') : t('telemetry.percent', { value: format.number(v) }));

  return (
    <div className="flex flex-col gap-om-16">
      <SectionTitle as="h1" size="lg" description={t('telemetry.description')}>
        {t('nav.telemetry')}
      </SectionTitle>

      <div role="group" aria-label={t('telemetry.filter.health')} className="flex flex-wrap items-center gap-om-8">
        {HEALTHS.map((h) => {
          const active = health.includes(h);
          return (
            <Pill
              key={h}
              variant={active ? 'primary' : 'default'}
              selected={active}
              onClick={() => {
                setHealth((current) => (current.includes(h) ? current.filter((x) => x !== h) : [...current, h]));
              }}
            >
              {first === undefined ? t(healthKey[h]) : t('telemetry.healthCount', { health: t(healthKey[h]), count: format.integer(first[h]) })}
            </Pill>
          );
        })}
      </div>

      <div role="group" aria-label={t('telemetry.filter.category')} className="flex flex-wrap items-center gap-om-8">
        <Pill
          variant={category === undefined ? 'primary' : 'default'}
          selected={category === undefined}
          onClick={() => {
            setCategory(undefined);
          }}
        >
          {t('telemetry.filter.all')}
        </Pill>
        {CATEGORIES.map((layer) => {
          const active = category === layer;
          return (
            <Pill
              key={layer}
              variant={active ? 'primary' : 'default'}
              selected={active}
              icon={<span aria-hidden="true" className="inline-block size-2 rounded-om-pill" style={{ background: layerColor(layer) }} />}
              onClick={() => {
                setCategory(active ? undefined : layer);
              }}
            >
              {t(layerKey(layer))}
            </Pill>
          );
        })}
        <label className="ms-auto flex items-center gap-om-6 text-om-2xs text-om-muted">
          <span>{t('telemetry.filter.text')}</span>
          <input
            type="search"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            className={inputClass}
          />
        </label>
      </div>

      <Card padding="4" className="overflow-hidden">
        <div role="table" aria-label={t('telemetry.table')} aria-rowcount={first?.total ?? -1} aria-busy={query.isPending || query.isFetchingNextPage} className="flex flex-col">
          <div role="row" className={cx(grid, 'h-10 border-b border-om-border-glass text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted')}>
            {COLUMNS.map((c) =>
              c.key === null ? (
                <span key={c.label} role="columnheader">
                  {t(c.label)}
                </span>
              ) : (
                <span key={c.label} role="columnheader" aria-sort={sort === c.key ? (c.key === 'name' ? 'ascending' : 'descending') : 'none'}>
                  <button
                    type="button"
                    className={cx('uppercase tracking-[0.08em] hover:text-om-cyan', sort === c.key && 'text-om-cyan')}
                    onClick={() => {
                      if (c.key !== null) setSort(c.key);
                    }}
                  >
                    {t(c.label)}
                  </button>
                </span>
              ),
            )}
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
            <div ref={parentRef} onScroll={onScroll} className="relative h-[min(64dvh,44rem)] overflow-y-auto">
              <div role="rowgroup" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const row: FleetRow | undefined = rows[item.index];
                  if (row === undefined) return null;
                  return (
                    <div
                      key={row.ci.id}
                      role="row"
                      aria-rowindex={item.index + 1}
                      className={cx(grid, 'absolute inset-x-0 top-0 border-b border-om-border-glass text-om-sm hover:bg-om-surface2/60')}
                      style={{ height: item.size, transform: 'translateY(' + String(item.start) + 'px)' }}
                    >
                      <span role="cell" className="min-w-0">
                        <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(row.ci.id))} className="block truncate font-medium text-om-primary hover:text-om-cyan">
                          {row.ci.displayName}
                        </Link>
                        <span className="block truncate font-om-mono text-om-2xs text-om-muted">{row.ci.type}</span>
                      </span>
                      <span role="cell" className="min-w-0">
                        <LayerBadge layer={row.ci.layer} label={t(layerKey(row.ci.layer))} />
                        <span className="block truncate font-om-mono text-om-2xs text-om-muted">{row.site ?? t('telemetry.none')}</span>
                      </span>
                      {/* Addresses are Latin: left-to-right, so a long FQDN loses its tail, not its host name, in Arabic. */}
                      <span role="cell" dir="ltr" className="truncate text-left rtl:text-right font-om-mono text-om-xs text-om-secondary">
                        {row.address ?? t('telemetry.none')}
                      </span>
                      <span role="cell">
                        <StateBadge state={row.health} label={t(healthKey[row.health])} />
                      </span>
                      <span role="cell" className="text-om-xs text-om-primary">
                        {percent(row.cpu)}
                      </span>
                      <span role="cell" className="text-om-xs text-om-primary">
                        {percent(row.memory)}
                      </span>
                      <span role="cell" className="text-om-xs text-om-primary">
                        {row.iops === null ? t('telemetry.none') : format.integer(row.iops)}
                      </span>
                      <span role="cell" className="text-om-xs text-om-primary">
                        {row.throughput === null ? t('telemetry.none') : t('telemetry.gbps', { value: format.number(row.throughput) })}
                      </span>
                      <span role="cell" className="text-om-xs">
                        {row.apdex === null ? (
                          <span className="text-om-primary">{t('telemetry.none')}</span>
                        ) : (
                          <StateBadge state={apdexState(row.apdex)} label={format.number(row.apdex)} />
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-om-12 border-t border-om-border-glass px-om-16 py-om-10 text-om-xs text-om-secondary">
          <span>{first === undefined ? t('common.loading') : t('telemetry.total', { count: format.integer(first.total) })}</span>
          {first !== undefined ? <span className="text-om-muted">{t('telemetry.asOf', { when: format.dateTime(first.asOf) })}</span> : null}
        </div>
      </Card>
    </div>
  );
}
