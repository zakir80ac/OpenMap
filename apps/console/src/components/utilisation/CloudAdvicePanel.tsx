'use client';
// REQ-AI-005 (ADR-054) — cloud recommendations on the Utilisation screen: each advised cloud resource with what to do
// (release, decommission, downsize, upsize), the estimated monthly saving, and the figures the advice rests on (state,
// SKU, monthly cost, average and peak load over the samples read, owner and environment); the total saving on top.
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { CloudRecommendationKind } from '@openmap/contracts';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import type { ReactNode } from 'react';
import { tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { cloudAdviceQuery } from '@/lib/cloud-advice-queries';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

const KIND_KEY = {
  release_stopped: 'cloudAdvice.kind.release_stopped',
  decommission_idle: 'cloudAdvice.kind.decommission_idle',
  downsize: 'cloudAdvice.kind.downsize',
  upsize: 'cloudAdvice.kind.upsize',
} as const satisfies Record<CloudRecommendationKind, MessageKey>;
const KIND_STATE = {
  release_stopped: 'degraded',
  decommission_idle: 'degraded',
  downsize: 'healthy',
  upsize: 'down',
} as const satisfies Record<CloudRecommendationKind, 'healthy' | 'degraded' | 'down'>;

export function CloudAdvicePanel({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const advice = useQuery(cloudAdviceQuery());
  const usd = (n: number): string => t('cloudAdvice.usd', { value: format.number(n) });
  const percent = (n: number | null): string => (n === null ? t('cloudAdvice.none') : t('cloudAdvice.percent', { value: format.number(n) }));

  return (
    <section aria-label={t('cloudAdvice.title')}>
      <Card className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm" description={t('cloudAdvice.description')}>
          {t('cloudAdvice.title')}
        </SectionTitle>
        {advice.isPending ? (
          <QueryState status="pending" />
        ) : advice.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void advice.refetch();
            }}
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-om-8 md:grid-cols-3" role="group" aria-label={t('cloudAdvice.summary')}>
              {[
                [t('cloudAdvice.summary.saving'), usd(advice.data.monthlySavingUsd)],
                [t('cloudAdvice.summary.items'), format.integer(advice.data.items.length)],
                [t('cloudAdvice.summary.resources'), format.integer(advice.data.resources)],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col gap-om-2 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8">
                  <span className="text-om-2xs uppercase tracking-wide text-om-muted">{label}</span>
                  <span className="text-om-md font-semibold text-om-primary">{value}</span>
                </div>
              ))}
            </div>
            {advice.data.items.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('cloudAdvice.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass} aria-label={t('cloudAdvice.table')}>
                  <thead className={theadClass}>
                    <tr>
                      <th scope="col" className={thClass}>
                        {t('cloudAdvice.column.resource')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('cloudAdvice.column.advice')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('cloudAdvice.column.saving')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('cloudAdvice.column.cost')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('cloudAdvice.column.load')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('cloudAdvice.column.owner')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {advice.data.items.map((r) => (
                      <tr key={r.ci.id}>
                        <td className={tdClass}>
                          <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(r.ci.id))} className="font-medium text-om-cyan hover:underline">
                            {r.ci.displayName}
                          </Link>
                          <span dir="ltr" className="block font-om-mono text-om-2xs text-om-muted">
                            {[r.sku, r.state].filter((x) => x !== null).join(' · ')}
                          </span>
                        </td>
                        <td className={tdClass}>
                          <Tag variant="state" state={KIND_STATE[r.kind]}>
                            {t(KIND_KEY[r.kind])}
                          </Tag>
                        </td>
                        <td className={tdClass}>{r.savingUsd > 0 ? usd(r.savingUsd) : t('cloudAdvice.none')}</td>
                        <td className={tdClass}>{r.monthlyCostUsd === null ? t('cloudAdvice.none') : usd(r.monthlyCostUsd)}</td>
                        <td className={tdClass}>
                          {r.samples === 0 ? (
                            t('cloudAdvice.none')
                          ) : (
                            <>
                              <span>{t('cloudAdvice.load', { average: percent(r.averageLoad), peak: percent(r.peakLoad) })}</span>
                              <span className="block text-om-2xs text-om-muted">
                                {t('cloudAdvice.samples', { count: format.integer(r.samples) })}
                                {r.loadAt !== null ? ' · ' + format.dateTime(r.loadAt) : ''}
                              </span>
                            </>
                          )}
                        </td>
                        <td className={tdClass}>
                          {r.owner ?? t('cloudAdvice.none')}
                          {r.environment !== null ? <span className="block text-om-2xs text-om-muted">{r.environment}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
