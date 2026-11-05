'use client';
// REQ-UI-012 REQ-BSM-008 — Uptime: availability of every business service per month, quarter or year beside its
// target (met / missed tone), the current period running to now, and the CSV export of the same report (ADR-024).
import Link from 'next/link';
import { SLA, type AvailabilityGranularity } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Card, SectionTitle, Segmented, Tag, cx } from '@openmap/ui';
import type { ReactNode } from 'react';
import { Button } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { localizedHref } from '@/lib/locale-path';
import type { AvailabilityPeriod, ServiceAvailability } from '@/lib/queries';
import { useFormatters, useT, type Translate } from '@/providers';
import type { Formatters } from '@/lib/format';

const FIRST_DAY = 1;

/** The period's label: month and year, Qn year, or the year. */
export function periodLabel(
  period: Pick<AvailabilityPeriod, 'granularity' | 'year' | 'month' | 'quarter'>,
  t: Translate,
  format: Formatters,
): string {
  if (period.granularity === 'month' && period.month !== null)
    return format.monthYear(new Date(Date.UTC(period.year, period.month - 1, FIRST_DAY)).toISOString());
  if (period.granularity === 'quarter' && period.quarter !== null)
    return t('services.uptime.period.quarter', {
      quarter: format.integer(period.quarter),
      year: format.integer(period.year),
    });
  return format.integer(period.year);
}

/** Tone class of a figure against its target. */
export function availabilityTone(period: Pick<AvailabilityPeriod, 'availabilityPercent' | 'met'>): string {
  if (period.availabilityPercent === null) return 'text-om-muted';
  if (period.met === null) return 'text-om-primary';
  return period.met ? 'text-om-emerald' : 'text-om-rose';
}

export interface UptimeTableProps {
  locale: Locale;
  rows: ReadonlyArray<ServiceAvailability>;
  status: 'pending' | 'error' | 'success';
  onRetry: () => void;
  granularity: AvailabilityGranularity;
  onGranularity: (next: AvailabilityGranularity) => void;
  onExport: () => void;
  exporting: boolean;
  exportError: boolean;
  /** Without a title the table renders bare (inside another card). */
  framed?: boolean;
}

export function UptimeTable({
  locale,
  rows,
  status,
  onRetry,
  granularity,
  onGranularity,
  onExport,
  exporting,
  exportError,
  framed = true,
}: UptimeTableProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const periods = rows[0]?.periods ?? [];
  const options = SLA.granularities.map((value) => ({
    value,
    label: t(
      ('services.uptime.' + value) as
        'services.uptime.month' | 'services.uptime.quarter' | 'services.uptime.year',
    ),
  }));
  const table =
    status === 'pending' ? (
      <QueryState status="pending" />
    ) : status === 'error' ? (
      <QueryState status="error" onRetry={onRetry} />
    ) : rows.length === 0 || periods.length === 0 ? (
      <p className="text-om-sm text-om-secondary">{t('services.uptime.empty')}</p>
    ) : (
      <div className="overflow-auto">
        <table
          className="w-full border-collapse text-om-xs"
          data-testid="uptime-table"
          data-granularity={granularity}
        >
          <thead className="text-om-2xs uppercase tracking-[0.08em] text-om-muted">
            <tr>
              <th scope="col" className="px-om-8 py-om-6 text-start font-semibold">
                {t('services.uptime.service')}
              </th>
              <th scope="col" className="px-om-8 py-om-6 text-start font-semibold">
                {t('services.uptime.target')}
              </th>
              {periods.map((p) => (
                <th
                  key={p.periodStart}
                  scope="col"
                  className="px-om-8 py-om-6 text-end font-semibold whitespace-nowrap"
                >
                  {periodLabel(p, t, format)}
                  {p.current ? (
                    <span className="block text-om-2xs font-normal normal-case tracking-normal text-om-muted">
                      {t('services.uptime.current')}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.service.id}
                className="border-t border-om-border-glass"
                data-service-id={row.service.id}
              >
                <td className="px-om-8 py-om-6">
                  <Link
                    href={localizedHref(locale, '/services/' + encodeURIComponent(row.service.id))}
                    className="font-medium text-om-primary hover:text-om-cyan"
                  >
                    {row.service.displayName}
                  </Link>
                  {row.sla !== null ? (
                    <span className="block text-om-2xs text-om-muted">{row.sla.name}</span>
                  ) : null}
                </td>
                <td className="px-om-8 py-om-6 text-om-secondary whitespace-nowrap">
                  {row.periods[0]?.targetPercent === null || row.periods[0]?.targetPercent === undefined
                    ? t('services.uptime.noTarget')
                    : format.percent(row.periods[0].targetPercent) + '%'}
                </td>
                {row.periods.map((p) => (
                  <td
                    key={p.periodStart}
                    className={cx(
                      'px-om-8 py-om-6 text-end font-om-mono whitespace-nowrap',
                      availabilityTone(p),
                    )}
                    title={
                      p.availabilityPercent === null
                        ? t('services.uptime.noData')
                        : t('services.uptime.cell', {
                            percent: format.percent(p.availabilityPercent),
                            down: format.integer(p.downtimeMinutes),
                            degraded: format.integer(p.degradedMinutes),
                            unknown: format.integer(p.unknownMinutes),
                          })
                    }
                  >
                    {p.availabilityPercent === null
                      ? t('services.uptime.noData')
                      : format.percent(p.availabilityPercent) + '%'}
                    {p.met === false ? (
                      <span className="ms-om-4">
                        <Tag variant="state" state="down">
                          {t('services.uptime.missed')}
                        </Tag>
                      </span>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  const controls = (
    <div className="flex flex-wrap items-center gap-om-8">
      <Segmented
        options={options}
        value={granularity}
        onChange={onGranularity}
        label={t('services.uptime.granularity')}
      />
      <Button tone="quiet" disabled={exporting || status !== 'success'} onClick={onExport}>
        {exporting ? t('services.uptime.exporting') : t('services.uptime.export')}
      </Button>
      {exportError ? (
        <span role="alert" className="text-om-xs text-om-rose">
          {t('services.uptime.exportError')}
        </span>
      ) : null}
    </div>
  );
  // The report arrives after the first paint; a fixed-height region keeps what follows the table in place (CLS).
  const region = <div className="h-[24rem] overflow-y-auto">{table}</div>;
  if (!framed) {
    return (
      <div className="flex flex-col gap-om-10">
        {controls}
        {region}
      </div>
    );
  }
  return (
    <Card as="section" className="flex flex-col gap-om-12" aria-labelledby="uptime-title">
      <SectionTitle as="h2" size="sm" description={t('services.uptime.subtitle')} action={controls}>
        <span id="uptime-title">{t('services.uptime.title')}</span>
      </SectionTitle>
      {region}
    </Card>
  );
}
