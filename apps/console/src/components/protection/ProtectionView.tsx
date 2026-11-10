'use client';
// REQ-INT-017 (ADR-075) — Protection: the CIs (VMs, hosts, databases, database clusters) that support business services
// of the chosen tier or more critical, how many of them backups protect within their RPO, and the gaps: unprotected
// first, then past their RPO, each with its last good backup, the RPO it is judged against, the backup's age and the
// services it supports. The gap table is virtualised (TanStack Virtual) and shows `gapRows` rows until "show all".
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BACKUP_AWARENESS, BSM, ITSM } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, Segmented, StateBadge, Tag, cx, spacing } from '@openmap/ui';
import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { localizedHref } from '@/lib/locale-path';
import { protectionGapsQuery, type CiProtection } from '@/lib/protection-queries';
import { useFormatters, useT } from '@/providers';
import { STATE_BADGE, STATE_KEY, duration } from './labels';

/** Two text lines plus padding, through the spacing scale so apps/ carries no numeric literal. */
const ROW_HEIGHT = spacing['28'] + spacing['28'];
const OVERSCAN_ROWS = spacing['8'];
const TIERS = [ITSM.priorityHighest, ITSM.priorityHigh, ITSM.priorityMedium] as const;

const grid =
  'grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,2fr)] items-center gap-om-10 px-om-16';

export function ProtectionView({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const [tier, setTier] = useState<string>(String(BACKUP_AWARENESS.criticalMaxTier));
  const [all, setAll] = useState(false);
  const first = all ? BACKUP_AWARENESS.gapsMaxFirst : BACKUP_AWARENESS.gapRows;
  const q = useQuery(protectionGapsQuery(Number(tier), first));
  const data = q.data;
  const none = t('common.none');
  const rows = data?.items ?? [];
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
  });
  const href = (id: string): string => localizedHref(locale, '/cmdb/' + encodeURIComponent(id));
  const count = (n: number | undefined): string => (n === undefined ? none : format.integer(n));
  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('protection.subtitle')}>
        {t('protection.title')}
      </SectionTitle>
      <div className="flex flex-wrap items-center gap-om-12">
        <span className="text-om-xs text-om-secondary">{t('protection.tierFilter')}</span>
        <Segmented
          label={t('protection.tierFilter')}
          value={tier}
          onChange={(v) => {
            setTier(v);
            setAll(false);
          }}
          options={TIERS.map((n) => ({
            value: String(n),
            label: t('protection.tierOrAbove', { tier: format.integer(n) }),
          }))}
        />
      </div>
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-6">
        <Kpi label={t('protection.kpi.services')} value={count(data?.criticalServices)} />
        <Kpi label={t('protection.kpi.cis')} value={count(data?.criticalCis)} />
        <Kpi label={t('protection.kpi.protected')} value={count(data?.protected)} />
        <Kpi label={t('protection.kpi.rpoBreached')} value={count(data?.rpoBreached)} lowerIsBetter />
        <Kpi label={t('protection.kpi.unprotected')} value={count(data?.unprotected)} lowerIsBetter />
        <Kpi
          label={t('protection.kpi.coverage')}
          value={
            data === undefined || data.criticalCis === 0
              ? none
              : format.percent((data.protected / data.criticalCis) * BSM.percentScale)
          }
          unit={t('protection.percentUnit')}
        />
      </div>
      <Card as="section" padding="4" className="flex flex-col">
        <div className="px-om-16 pt-om-16">
          <SectionTitle as="h2" size="sm" description={t('protection.gaps.hint')}>
            {t('protection.gaps.title')}
          </SectionTitle>
        </div>
        <div role="table" aria-label={t('protection.gaps.title')} className="mt-om-12">
          <div role="row" className={cx(grid, 'py-om-8 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted')}>
            <span role="columnheader">{t('protection.column.ci')}</span>
            <span role="columnheader">{t('protection.column.state')}</span>
            <span role="columnheader">{t('protection.column.lastGood')}</span>
            <span role="columnheader">{t('protection.column.rpo')}</span>
            <span role="columnheader">{t('protection.column.age')}</span>
            <span role="columnheader">{t('protection.column.services')}</span>
          </div>
          {q.isPending ? (
            <QueryState status="pending" className="m-om-12" />
          ) : q.isError ? (
            <QueryState
              status="error"
              className="m-om-12"
              onRetry={() => {
                void q.refetch();
              }}
            />
          ) : rows.length === 0 ? (
            <p className="px-om-16 pb-om-16 text-om-sm text-om-secondary" data-testid="protection-empty">
              {t('protection.gaps.empty')}
            </p>
          ) : (
            <div ref={parentRef} className="relative h-[min(64dvh,44rem)] overflow-y-auto">
              <div role="rowgroup" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const row: CiProtection | undefined = rows[item.index];
                  if (row === undefined) return null;
                  return (
                    <GapRow
                      key={row.ci.id}
                      row={row}
                      index={item.index}
                      href={href}
                      style={{ height: item.size, transform: 'translateY(' + String(item.start) + 'px)' }}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-om-12 border-t border-om-border-glass px-om-16 py-om-10 text-om-xs text-om-secondary">
          <span>
            {data === undefined
              ? t('common.loading')
              : t('protection.gaps.shown', {
                  shown: format.integer(rows.length),
                  total: format.integer(data.unprotected + data.rpoBreached),
                })}
          </span>
          {data?.truncated === true ? (
            <span className="flex items-center gap-om-8" data-testid="protection-truncated">
              <span className="text-om-muted">{t('protection.gaps.truncated')}</span>
              {!all ? (
                <Button
                  tone="quiet"
                  onClick={() => {
                    setAll(true);
                  }}
                >
                  {t('protection.gaps.showAll')}
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function GapRow({
  row,
  index,
  href,
  style,
}: {
  row: CiProtection;
  index: number;
  href: (id: string) => string;
  style: { height: number; transform: string };
}): ReactNode {
  const t = useT();
  const format = useFormatters();
  const none = t('common.none');
  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      data-ci={row.ci.id}
      data-state={row.state}
      className={cx(grid, 'absolute inset-x-0 top-0 border-b border-om-border-glass text-om-sm hover:bg-om-surface2/60')}
      style={style}
    >
      <span role="cell" className="min-w-0">
        <Link href={href(row.ci.id)} className="block truncate font-medium text-om-primary hover:text-om-cyan">
          <bdi>{row.ci.displayName}</bdi>
        </Link>
        <span className="block truncate font-om-mono text-om-2xs text-om-muted">{row.ci.type}</span>
      </span>
      <span role="cell">
        <StateBadge state={STATE_BADGE[row.state]} label={t(STATE_KEY[row.state])} />
      </span>
      <span role="cell" className="text-om-xs text-om-primary">
        {row.lastGoodBackupAt === null ? (
          row.covers.length === 0 ? none : t('protection.neverBackedUp')
        ) : (
          <time dateTime={row.lastGoodBackupAt}>{format.dateTime(row.lastGoodBackupAt)}</time>
        )}
      </span>
      <span role="cell" className="text-om-xs text-om-primary">
        {duration(t, format, row.targetRpoMinutes)}
        {row.policyRpoMinutes !== null ? (
          <span className="block text-om-2xs text-om-muted">
            {t('protection.policyRpo', { rpo: duration(t, format, row.policyRpoMinutes) })}
          </span>
        ) : null}
      </span>
      <span role="cell" className="text-om-xs text-om-primary">
        {row.ageMinutes === null ? none : duration(t, format, row.ageMinutes)}
      </span>
      <span role="cell" className="flex min-w-0 flex-wrap gap-om-4">
        {row.services.map((s) => (
          <Tag key={s.service.id}>
            <bdi>{s.service.displayName}</bdi>
            {' · '}
            {t('protection.tier', { tier: format.integer(s.tier) })}
          </Tag>
        ))}
      </span>
    </div>
  );
}
