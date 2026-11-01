// REQ-CMDB-038 — the one measurement every card and table row shows for a CI: the layer's headline metric from
// ClickHouse, labelled through the contract key (`metric.<key>`) and printed with the contract's unit. A CI whose
// metric has no sample yet says so instead of showing a dash, and the sample's instant is the tooltip.
import { CI_LAYERS, LAYER_HEADLINE_METRIC, type HeadlineMetricKey } from '@openmap/contracts';
import { cx } from '@openmap/ui';
import type { ReactNode } from 'react';
import { metricKey } from '@/lib/keys';
import type { HeadlineMetric as HeadlineMetricValue } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';

export interface HeadlineMetricProps {
  metric: HeadlineMetricValue;
  /** `row` is the single-line table cell; `card` stacks the label above a larger value. */
  variant?: 'row' | 'card';
  className?: string;
}

const HEADLINE_KEYS: ReadonlySet<string> = new Set(CI_LAYERS.map((layer) => LAYER_HEADLINE_METRIC[layer].key));

/** The API serves the contract's keys; an unknown one (a newer server) falls back to the label it sent. */
export function isHeadlineMetricKey(key: string): key is HeadlineMetricKey {
  return HEADLINE_KEYS.has(key);
}

export function HeadlineMetric({ metric, variant = 'row', className }: HeadlineMetricProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const label = isHeadlineMetricKey(metric.key) ? t(metricKey(metric.key)) : metric.label;
  const value = metric.value === null ? null : format.number(metric.value) + (metric.unit === '' ? '' : ' ' + metric.unit);
  const title = metric.observedAt === null ? undefined : t('metric.sampledAt', { when: format.dateTime(metric.observedAt) });
  if (variant === 'card') {
    return (
      <div className={cx('flex flex-col', className)} title={title} data-metric={metric.metric}>
        <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{label}</span>
        {value === null ? (
          <span className="text-om-sm text-om-muted">{t('metric.noSample')}</span>
        ) : (
          <span className="font-om-display text-om-xl font-bold text-om-primary">{value}</span>
        )}
      </div>
    );
  }
  return (
    <span className={cx('flex min-w-0 items-baseline gap-om-6', className)} title={title} data-metric={metric.metric}>
      <span className="truncate text-om-2xs uppercase tracking-[0.08em] text-om-muted">{label}</span>
      {value === null ? (
        <span className="truncate text-om-xs text-om-muted">{t('metric.noSample')}</span>
      ) : (
        <span className="truncate font-om-mono text-om-sm text-om-primary">{value}</span>
      )}
    </span>
  );
}
