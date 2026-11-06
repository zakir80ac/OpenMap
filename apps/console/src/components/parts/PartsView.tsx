'use client';
// REQ-CMDB-014 (ADR-037) — Parts: every component discovery found inside the estate's hosts, blades and arrays, by kind
// and model, with the CI that holds it, its serial, capacity and details; text and kind filters, removed parts on
// request, server-side pages, and the most common kind-and-model rows for the filter (what to stock as spares).
import { useQuery } from '@tanstack/react-query';
import { COMPONENTS } from '@openmap/constants';
import { COMPONENT_KINDS, type ComponentKind } from '@openmap/contracts';
import type { Locale } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, StateBadge } from '@openmap/ui';
import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
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
import { partsQuery, type ComponentFilter } from '@/lib/component-queries';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';
import { Capacity, PartDetails, kindKey } from './PartCells';

function isKind(value: string): value is ComponentKind {
  return (COMPONENT_KINDS as readonly string[]).includes(value);
}

/** First and last row numbers of a page, 1-based, for the range label. */
export function pageRange(offset: number, shown: number): { from: number; to: number } {
  return { from: shown === 0 ? 0 : offset + 1, to: offset + shown };
}

export function PartsView({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const [kind, setKind] = useState('');
  const [removed, setRemoved] = useState(false);
  const [offset, setOffset] = useState(0);
  const filter: ComponentFilter = {};
  if (text.trim() !== '') filter.text = text.trim();
  if (isKind(kind)) filter.kind = kind;
  if (removed) filter.includeRemoved = true;
  const page = useQuery(partsQuery(filter, COMPONENTS.pageSize, offset));
  const data = page.data;
  const range = pageRange(offset, data?.items.length ?? 0);
  const resetPage = (): void => {
    setOffset(0);
  };

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('parts.subtitle')}>
        {t('parts.title')}
      </SectionTitle>
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-4">
        <Kpi
          label={t('parts.kpi.total')}
          value={data === undefined ? t('common.none') : format.integer(data.total)}
        />
        {(data?.models ?? []).slice(0, COMPONENTS.headlineModels).map((m) => (
          <Kpi
            key={m.kind + ':' + (m.model ?? '')}
            label={t(kindKey(m.kind)) + ' · ' + (m.model ?? t('parts.unknownModel'))}
            value={format.integer(m.count)}
          />
        ))}
      </div>
      <Card padding="24" className="flex flex-col gap-om-16" as="section">
        <SectionTitle as="h2" size="sm" description={t('parts.register.subtitle')}>
          {t('parts.register.title')}
        </SectionTitle>
        <div className="flex flex-wrap items-end gap-om-10">
          <Field id={id + '-text'} label={t('parts.filter.text')}>
            <TextInput
              id={id + '-text'}
              type="search"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                resetPage();
              }}
            />
          </Field>
          <Field id={id + '-kind'} label={t('parts.filter.kind')}>
            <Select
              id={id + '-kind'}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                resetPage();
              }}
            >
              <option value="">{t('parts.kind.all')}</option>
              {COMPONENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(kindKey(k))}
                </option>
              ))}
            </Select>
          </Field>
          <label
            htmlFor={id + '-removed'}
            className="flex items-center gap-om-6 pb-om-6 text-om-xs text-om-secondary"
          >
            <input
              id={id + '-removed'}
              type="checkbox"
              checked={removed}
              onChange={(event) => {
                setRemoved(event.target.checked);
                resetPage();
              }}
            />
            <span>{t('parts.filter.removed')}</span>
          </label>
        </div>
        {data !== undefined && data.models.length > 0 ? (
          <div className="flex flex-col gap-om-6" data-testid="part-models">
            <h3 className="text-om-xs font-semibold text-om-secondary">{t('parts.models.title')}</h3>
            <ul className="flex flex-wrap gap-om-6">
              {data.models.map((m) => (
                <li
                  key={m.kind + ':' + (m.model ?? '')}
                  className="rounded-om-pill bg-om-surface3 px-om-10 py-om-4 text-om-2xs text-om-secondary"
                >
                  {t('parts.models.row', {
                    kind: t(kindKey(m.kind)),
                    model: m.model ?? t('parts.unknownModel'),
                    count: format.integer(m.count),
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
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
          <p className="text-om-sm text-om-secondary">{t('parts.register.empty')}</p>
        ) : (
          <>
            <div className="overflow-x-auto" data-testid="part-register">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>
                      {t('parts.table.kind')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('parts.table.model')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('parts.table.ci')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('parts.table.serial')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('parts.table.capacity')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('parts.table.details')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((p) => (
                    <tr key={p.id} className={rowClass} data-part={p.ci.displayName + ':' + p.slot}>
                      <td className={tdClass}>
                        {t(kindKey(p.kind))}
                        {p.removedAt !== null ? (
                          <span className="mt-om-2 block">
                            <StateBadge
                              state="down"
                              label={t('parts.removed', { when: format.dateTime(p.removedAt) })}
                            />
                          </span>
                        ) : null}
                      </td>
                      <td className={tdClass}>
                        <span className="text-om-primary">
                          {p.model ?? p.partNumber ?? t('parts.unknownModel')}
                        </span>
                        {p.manufacturer !== null ? (
                          <span className="block text-om-2xs text-om-muted">{p.manufacturer}</span>
                        ) : null}
                      </td>
                      <td className={tdClass}>
                        <Link
                          href={localizedHref(locale, '/cmdb/' + encodeURIComponent(p.ci.id))}
                          className="text-om-primary hover:text-om-cyan"
                        >
                          {p.ci.displayName}
                        </Link>
                        <span className="block font-om-mono text-om-2xs text-om-muted">{p.slot}</span>
                      </td>
                      <td className={tdClass + ' font-om-mono text-om-xs text-om-secondary'}>
                        {p.serialNumber ?? t('common.none')}
                      </td>
                      <td className={tdClass}>
                        <Capacity part={p} locale={locale} />
                      </td>
                      <td className={tdClass}>
                        <PartDetails details={p.details} t={t} format={format} />
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
                    setOffset(Math.max(0, offset - COMPONENTS.pageSize));
                  }}
                >
                  {t('parts.page.previous')}
                </Button>
                <Button
                  tone="quiet"
                  disabled={range.to >= data.total}
                  onClick={() => {
                    setOffset(offset + COMPONENTS.pageSize);
                  }}
                >
                  {t('parts.page.next')}
                </Button>
              </span>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
