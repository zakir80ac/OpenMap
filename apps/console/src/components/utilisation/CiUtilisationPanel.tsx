'use client';
// REQ-CMDB-034 — a CI's Utilisation tab: CPU, memory, fullest disk and power over a chosen window (UTILISATION's
// windows), each with its latest value, average and peak and the bucketed history as a sparkline; hot or idle state.
import { useQuery } from '@tanstack/react-query';
import { UTILISATION } from '@openmap/constants';
import { Card, SectionTitle, Sparkline, accents } from '@openmap/ui';
import { useId, useState, type ReactNode } from 'react';
import { Field, Select } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { ciUtilisationQuery } from '@/lib/utilisation-queries';
import { useFormatters, useT } from '@/providers';
import { StateTag, measureKey, measureText, percentAccent } from './measures';

export function CiUtilisationPanel({ ciId }: { ciId: string }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [hours, setHours] = useState<number>(UTILISATION.defaultWindowHours);
  const query = useQuery(ciUtilisationQuery(ciId, hours));
  const data = query.data;

  return (
    <div data-testid="ci-utilisation">
      <Card as="section" className="flex flex-col gap-om-12">
        <div className="flex flex-wrap items-end justify-between gap-om-10">
          <SectionTitle as="h2" size="sm" description={t('utilisation.ci.subtitle')}>
            {t('utilisation.ci.title')}
          </SectionTitle>
          <span className="flex items-end gap-om-10">
            {data !== null && data !== undefined ? <StateTag state={data.state} t={t} /> : null}
            <Field id={id + '-window'} label={t('utilisation.ci.window')}>
              <Select
                id={id + '-window'}
                value={String(hours)}
                onChange={(event) => {
                  setHours(Number(event.target.value));
                }}
              >
                {UTILISATION.windowsHours.map((h) => (
                  <option key={h} value={String(h)}>
                    {t('utilisation.ci.hours', { hours: format.integer(h) })}
                  </option>
                ))}
              </Select>
            </Field>
          </span>
        </div>
        {query.isPending ? (
          <QueryState status="pending" />
        ) : query.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : data === null ||
          data === undefined ||
          data.series.every((s) => s.latest === null && s.points.length === 0) ? (
          <p className="text-om-sm text-om-secondary">{t('utilisation.ci.empty')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-om-12 md:grid-cols-2">
            {data.series.map((s) => (
              <section
                key={s.measure}
                className="flex flex-col gap-om-6 rounded-om-control border border-om-border-glass p-om-12"
                data-measure={s.measure}
              >
                <h3 className="text-om-xs font-semibold text-om-secondary">{t(measureKey(s.measure))}</h3>
                <p className="font-om-mono text-om-2xl text-om-primary">
                  {s.latest === null ? t('common.none') : measureText(s.unit, s.latest, t, format)}
                </p>
                <p className="text-om-2xs text-om-muted">
                  {s.average === null || s.peak === null
                    ? t('utilisation.ci.noHistory')
                    : t('utilisation.ci.averagePeak', {
                        average: measureText(s.unit, s.average, t, format),
                        peak: measureText(s.unit, s.peak, t, format),
                      })}
                </p>
                {s.points.length > 1 ? (
                  <Sparkline
                    values={s.points.map((p) => p.value)}
                    accent={s.unit === 'W' ? accents.blue : percentAccent(s.peak ?? 0)}
                    label={t('utilisation.ci.trend', { measure: t(measureKey(s.measure)) })}
                  />
                ) : null}
              </section>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
