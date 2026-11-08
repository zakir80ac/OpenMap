'use client';
// REQ-CMDB-034 — Utilisation: every server, VM, container and PDU that reports CPU, memory, disk or power, with its
// latest values hottest first by the chosen measure; hot CIs (capacity at risk) and idle ones (rightsizing or reclaim
// candidates) under UTILISATION's thresholds; headline counts, averages and total power; type, state and name filters
// and server-side pages.
// REQ-AI-005: below them, the cloud recommendations (CloudAdvicePanel).
import { useQuery } from '@tanstack/react-query';
import { UTILISATION } from '@openmap/constants';
import { UTILISATION_CI_TYPES, UTILISATION_MEASURES, type UtilisationState } from '@openmap/contracts';
import type { Locale } from '@openmap/i18n';
import { Card, Kpi, SectionTitle } from '@openmap/ui';
import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { CloudAdvicePanel } from './CloudAdvicePanel';
import {
  Button,
  Field,
  Select,
  TextInput,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { pageRange } from '@/components/parts/PartsView';
import { localizedHref } from '@/lib/locale-path';
import { utilisationQuery, type UtilisationFilter, type UtilisationSort } from '@/lib/utilisation-queries';
import { useFormatters, useT } from '@/providers';
import { PercentCell, StateTag, measureKey, percentText, stateKey } from './measures';

const STATES: readonly UtilisationState[] = ['hot', 'idle', 'normal', 'unknown'];
const SORTS: readonly UtilisationSort[] = [...UTILISATION_MEASURES, 'name'];

function isState(v: string): v is UtilisationState {
  return (STATES as readonly string[]).includes(v);
}

function isSort(v: string): v is UtilisationSort {
  return (SORTS as readonly string[]).includes(v);
}

export function UtilisationView({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const [type, setType] = useState('');
  const [state, setState] = useState('');
  const [sort, setSort] = useState<UtilisationSort>('cpu');
  const [offset, setOffset] = useState(0);
  const filter: UtilisationFilter = {};
  if (text.trim() !== '') filter.text = text.trim();
  if (type !== '') filter.types = [type];
  if (isState(state)) filter.state = state;
  const page = useQuery(utilisationQuery(filter, sort, UTILISATION.pageSize, offset));
  const data = page.data;
  const range = pageRange(offset, data?.items.length ?? 0);
  const reset = (): void => {
    setOffset(0);
  };
  const none = t('common.none');

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('app.name')}
        description={t('utilisation.subtitle', {
          hot: format.integer(UTILISATION.hotPercent),
          idle: format.integer(UTILISATION.idlePercent),
        })}
      >
        {t('utilisation.title')}
      </SectionTitle>
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-6">
        <Kpi
          label={t('utilisation.kpi.reporting')}
          value={data === undefined ? none : format.integer(data.total)}
        />
        <Kpi
          label={t('utilisation.kpi.hot')}
          value={data === undefined ? none : format.integer(data.hot)}
          lowerIsBetter
        />
        <Kpi
          label={t('utilisation.kpi.idle')}
          value={data === undefined ? none : format.integer(data.idle)}
          lowerIsBetter
        />
        <Kpi
          label={t('utilisation.kpi.cpu')}
          value={data?.averageCpu == null ? none : percentText(data.averageCpu, t, format)}
        />
        <Kpi
          label={t('utilisation.kpi.memory')}
          value={data?.averageMemory == null ? none : percentText(data.averageMemory, t, format)}
        />
        <Kpi
          label={t('utilisation.kpi.power')}
          value={
            data?.powerWatts == null
              ? none
              : t('utilisation.kilowatts', {
                  value: format.number(data.powerWatts / UTILISATION.wattsPerKilowatt),
                })
          }
        />
      </div>
      <Card padding="24" className="flex flex-col gap-om-16" as="section">
        <SectionTitle as="h2" size="sm" description={t('utilisation.register.subtitle')}>
          {t('utilisation.register.title')}
        </SectionTitle>
        <div className="flex flex-wrap items-end gap-om-10">
          <Field id={id + '-text'} label={t('utilisation.filter.text')}>
            <TextInput
              id={id + '-text'}
              type="search"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                reset();
              }}
            />
          </Field>
          <Field id={id + '-type'} label={t('utilisation.filter.type')}>
            <Select
              id={id + '-type'}
              value={type}
              onChange={(event) => {
                setType(event.target.value);
                reset();
              }}
            >
              <option value="">{t('utilisation.filter.anyType')}</option>
              {UTILISATION_CI_TYPES.map((ciType) => (
                <option key={ciType} value={ciType}>
                  {ciType}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={id + '-state'} label={t('utilisation.filter.state')}>
            <Select
              id={id + '-state'}
              value={state}
              onChange={(event) => {
                setState(event.target.value);
                reset();
              }}
            >
              <option value="">{t('utilisation.filter.anyState')}</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {t(stateKey(s))}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={id + '-sort'} label={t('utilisation.filter.sort')}>
            <Select
              id={id + '-sort'}
              value={sort}
              onChange={(event) => {
                if (isSort(event.target.value)) setSort(event.target.value);
                reset();
              }}
            >
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {s === 'name' ? t('utilisation.sort.name') : t(measureKey(s))}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {page.isPending ? (
          <QueryState status="pending" />
        ) : page.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void page.refetch();
            }}
          />
        ) : data === undefined || data.items.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('utilisation.register.empty')}</p>
        ) : (
          <>
            <div className="overflow-x-auto" data-testid="utilisation-register">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>
                      {t('utilisation.table.ci')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('utilisation.table.state')}
                    </th>
                    {UTILISATION_MEASURES.map((m) => (
                      <th key={m} scope="col" className={thClass}>
                        {t(measureKey(m))}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr
                      key={row.ci.id}
                      className={rowClass}
                      data-utilisation={row.ci.displayName}
                      data-state={row.state}
                    >
                      <td className={tdClass}>
                        <Link
                          href={localizedHref(locale, '/cmdb/' + encodeURIComponent(row.ci.id))}
                          className="text-om-primary hover:text-om-cyan"
                        >
                          {row.ci.displayName}
                        </Link>
                        <span className="block font-om-mono text-om-2xs text-om-muted">{row.ci.type}</span>
                      </td>
                      <td className={tdClass}>
                        <StateTag state={row.state} t={t} />
                      </td>
                      <td className={tdClass}>
                        <PercentCell value={row.cpu} label={t(measureKey('cpu'))} format={format} t={t} />
                      </td>
                      <td className={tdClass}>
                        <PercentCell
                          value={row.memory}
                          label={t(measureKey('memory'))}
                          format={format}
                          t={t}
                        />
                      </td>
                      <td className={tdClass}>
                        <PercentCell value={row.disk} label={t(measureKey('disk'))} format={format} t={t} />
                      </td>
                      <td className={tdClass + ' font-om-mono text-om-xs text-om-secondary'}>
                        {row.power === null
                          ? none
                          : t('utilisation.watts', { value: format.integer(row.power) })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-om-10 text-om-xs text-om-secondary">
              <span>
                {t('parts.page.range', {
                  from: format.integer(range.from),
                  to: format.integer(range.to),
                  total: format.integer(data.total),
                })}
              </span>
              <span className="flex gap-om-6">
                <Button
                  tone="quiet"
                  disabled={offset === 0}
                  onClick={() => {
                    setOffset(Math.max(0, offset - UTILISATION.pageSize));
                  }}
                >
                  {t('parts.page.previous')}
                </Button>
                <Button
                  tone="quiet"
                  disabled={range.to >= data.total}
                  onClick={() => {
                    setOffset(offset + UTILISATION.pageSize);
                  }}
                >
                  {t('parts.page.next')}
                </Button>
              </span>
            </div>
          </>
        )}
      </Card>
      <CloudAdvicePanel locale={locale} />
    </div>
  );
}
