'use client';
// REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — Lifecycle: the operating systems, hypervisors and network operating systems the
// estate runs, each release with how many CIs run it, the end of security and extended support from the catalogue and
// whether it is supported, ending or ended (OS rows also show hosts behind on patches); hardware end of sale and support
// by model from the asset register; the catalogue's sources and, for admins where outbound calls are allowed, a sync.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LIFECYCLE, ROLES } from '@openmap/constants';
import { LIFECYCLE_STATES, type LifecycleKind, type LifecycleState } from '@openmap/contracts';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, StateBadge, Tag } from '@openmap/ui';
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
import { useCan } from '@/lib/auth';
import {
  lifecycleCatalogueQuery,
  lifecycleHardwareQuery,
  lifecycleInstancesQuery,
  lifecycleReleasesQuery,
  syncLifecycleCatalogue,
  type LifecycleRelease,
  type ReleaseFilter,
} from '@/lib/lifecycle-queries';
import { localizedHref } from '@/lib/locale-path';
import type { Formatters } from '@/lib/format';
import { useFormatters, useT, type Translate } from '@/providers';

const TABS = ['os', 'platforms', 'hardware'] as const;
type Tab = (typeof TABS)[number];
const PLATFORM_KINDS: readonly LifecycleKind[] = ['hypervisor', 'network_os'];

/** StateBadge state per lifecycle state. */
export const BADGE: Record<LifecycleState, 'healthy' | 'at_risk' | 'down' | 'unknown'> = {
  supported: 'healthy',
  ending: 'at_risk',
  ended: 'down',
  unknown: 'unknown',
};

function stateKey(state: LifecycleState): MessageKey {
  return ('lifecycle.state.' + state) as MessageKey;
}

function isState(v: string): v is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(v);
}

/** The badge text: days left, ended how long ago, or the state alone without a date. */
export function supportText(
  r: { state: LifecycleState; daysLeft: number | null },
  t: Translate,
  format: Formatters,
): string {
  if (r.daysLeft === null) return t(stateKey(r.state));
  return r.daysLeft < 0
    ? t('lifecycle.endedAgo', { days: format.integer(-r.daysLeft) })
    : t('lifecycle.daysLeft', { days: format.integer(r.daysLeft) });
}

function Instances({
  filter,
  row,
  locale,
}: {
  filter: ReleaseFilter;
  row: LifecycleRelease;
  locale: Locale;
}): ReactNode {
  const t = useT();
  const q = useQuery(lifecycleInstancesQuery(filter, row.key));
  if (q.isPending) return <QueryState status="pending" />;
  if (q.isError) return <QueryState status="error" onRetry={() => void q.refetch()} />;
  return (
    <ul className="flex flex-wrap gap-om-6" data-testid="lifecycle-instances">
      {q.data.map((ci) => (
        <li key={ci.id}>
          <Link
            href={localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id))}
            className="font-om-mono text-om-2xs text-om-secondary hover:text-om-cyan"
          >
            {ci.displayName}
          </Link>
        </li>
      ))}
      {row.count > q.data.length ? (
        <li className="text-om-2xs text-om-muted">
          {t('lifecycle.more', { count: String(row.count - q.data.length) })}
        </li>
      ) : null}
    </ul>
  );
}

function Releases({ kinds, locale }: { kinds: readonly LifecycleKind[]; locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const [state, setState] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const filter: ReleaseFilter = {};
  if (kinds.length === 1 && kinds[0] !== undefined) filter.kind = kinds[0];
  if (text.trim() !== '') filter.text = text.trim();
  if (isState(state)) filter.state = state;
  const page = useQuery(lifecycleReleasesQuery(filter));
  const rows = (page.data?.rows ?? []).filter((r) => kinds.includes(r.kind));
  const isOs = kinds.includes('os');
  // One kind: the server's counts (before the state filter); several: summed from the rows shown.
  const counts: Record<LifecycleState, number> =
    filter.kind !== undefined && page.data !== undefined
      ? page.data
      : {
          supported: 0,
          ending: 0,
          ended: 0,
          unknown: 0,
          ...Object.fromEntries(
            LIFECYCLE_STATES.map((s) => [
              s,
              rows.filter((r) => r.state === s).reduce((n, r) => n + r.count, 0),
            ]),
          ),
        };
  return (
    <div className="flex flex-col gap-om-16">
      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-4">
        {(['ended', 'ending', 'unknown', 'supported'] as const).map((s) => (
          <Kpi
            key={s}
            label={t(('lifecycle.kpi.' + s) as MessageKey)}
            value={page.data === undefined ? t('common.none') : format.integer(counts[s])}
            lowerIsBetter={s !== 'supported'}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-om-10">
        <Field id={id + '-text'} label={t('lifecycle.filter.text')}>
          <TextInput
            id={id + '-text'}
            type="search"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </Field>
        <Field id={id + '-state'} label={t('lifecycle.filter.state')}>
          <Select
            id={id + '-state'}
            value={state}
            onChange={(event) => {
              setState(event.target.value);
            }}
          >
            <option value="">{t('lifecycle.filter.anyState')}</option>
            {LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>
                {t(stateKey(s))}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {page.isPending ? (
        <QueryState status="pending" />
      ) : page.isError ? (
        <QueryState status="error" onRetry={() => void page.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('lifecycle.empty')}</p>
      ) : (
        <div className="overflow-x-auto" data-testid="lifecycle-releases">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>
                  {t('lifecycle.table.release')}
                </th>
                <th scope="col" className={thClass}>
                  {t('lifecycle.table.count')}
                </th>
                <th scope="col" className={thClass}>
                  {t('lifecycle.table.support')}
                </th>
                <th scope="col" className={thClass}>
                  {t('lifecycle.table.extended')}
                </th>
                {isOs ? (
                  <th scope="col" className={thClass}>
                    {t('lifecycle.table.patches')}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={rowClass} data-release={r.key} data-state={r.state}>
                  <td className={tdClass}>
                    <button
                      type="button"
                      className="text-start text-om-primary hover:text-om-cyan"
                      aria-expanded={open === r.key}
                      onClick={() => {
                        setOpen(open === r.key ? null : r.key);
                      }}
                    >
                      {r.label}
                    </button>
                    {r.entry === null ? (
                      <span className="mt-om-2 block">
                        <Tag>{t('lifecycle.notInCatalogue')}</Tag>
                      </span>
                    ) : null}
                    {r.versions.length > 0 ? (
                      <span className="block font-om-mono text-om-2xs text-om-muted">
                        {r.versions.join(', ')}
                      </span>
                    ) : null}
                    {open === r.key ? (
                      <div className="mt-om-6">
                        <Instances filter={filter} row={r} locale={locale} />
                      </div>
                    ) : null}
                  </td>
                  <td className={tdClass + ' font-om-mono text-om-xs'}>{format.integer(r.count)}</td>
                  <td className={tdClass}>
                    <span className="flex flex-col gap-om-2">
                      {r.entry?.endOfSupport != null ? (
                        <span className="text-om-secondary">{format.date(r.entry.endOfSupport)}</span>
                      ) : null}
                      <StateBadge state={BADGE[r.state]} label={supportText(r, t, format)} />
                    </span>
                  </td>
                  <td className={tdClass + ' text-om-secondary'}>
                    {r.entry?.extendedSupportEnd != null
                      ? format.date(r.entry.extendedSupportEnd)
                      : t('common.none')}
                  </td>
                  {isOs ? (
                    <td className={tdClass + ' text-om-xs text-om-secondary'}>
                      {r.patchBehind === null || r.patchBehind === 0
                        ? t('lifecycle.patches.current')
                        : t('lifecycle.patches.behind', {
                            count: format.integer(r.patchBehind),
                            days: format.integer(LIFECYCLE.patchStaleDays),
                          })}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Hardware(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [text, setText] = useState('');
  const [state, setState] = useState('');
  const filter: { text?: string; state?: LifecycleState } = {};
  if (text.trim() !== '') filter.text = text.trim();
  if (isState(state)) filter.state = state;
  const q = useQuery(lifecycleHardwareQuery(filter));
  return (
    <div className="flex flex-col gap-om-16">
      <p className="text-om-xs text-om-secondary">{t('lifecycle.hardware.hint')}</p>
      <div className="flex flex-wrap items-end gap-om-10">
        <Field id={id + '-text'} label={t('lifecycle.filter.model')}>
          <TextInput
            id={id + '-text'}
            type="search"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </Field>
        <Field id={id + '-state'} label={t('lifecycle.filter.state')}>
          <Select
            id={id + '-state'}
            value={state}
            onChange={(event) => {
              setState(event.target.value);
            }}
          >
            <option value="">{t('lifecycle.filter.anyState')}</option>
            {LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>
                {t(stateKey(s))}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {q.isPending ? (
        <QueryState status="pending" />
      ) : q.isError ? (
        <QueryState status="error" onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('lifecycle.empty')}</p>
      ) : (
        <div className="overflow-x-auto" data-testid="lifecycle-hardware">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>
                  {t('lifecycle.table.model')}
                </th>
                <th scope="col" className={thClass}>
                  {t('lifecycle.table.count')}
                </th>
                <th scope="col" className={thClass}>
                  {t('lifecycle.table.endOfSale')}
                </th>
                <th scope="col" className={thClass}>
                  {t('lifecycle.table.support')}
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.key} className={rowClass} data-model={r.model ?? ''} data-state={r.state}>
                  <td className={tdClass}>
                    <span className="text-om-primary">{r.model ?? t('lifecycle.unknownModel')}</span>
                    <span className="block text-om-2xs text-om-muted">
                      {(r.manufacturer ?? '') + ' · ' + r.ciType}
                    </span>
                  </td>
                  <td className={tdClass + ' text-om-xs text-om-secondary'}>
                    {t('lifecycle.hardware.dated', {
                      dated: format.integer(r.dated),
                      count: format.integer(r.count),
                    })}
                  </td>
                  <td className={tdClass + ' text-om-secondary'}>
                    {r.endOfSale === null ? t('common.none') : format.date(r.endOfSale)}
                  </td>
                  <td className={tdClass}>
                    <span className="flex flex-col gap-om-2">
                      {r.endOfSupport !== null ? (
                        <span className="text-om-secondary">{format.date(r.endOfSupport)}</span>
                      ) : null}
                      <StateBadge state={BADGE[r.state]} label={supportText(r, t, format)} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Catalogue(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const client = useQueryClient();
  const q = useQuery(lifecycleCatalogueQuery());
  const sync = useMutation({
    mutationFn: syncLifecycleCatalogue,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['lifecycle-catalogue'] });
      void client.invalidateQueries({ queryKey: ['lifecycle-releases'] });
    },
  });
  return (
    <div data-testid="lifecycle-catalogue">
      <Card as="section" padding="24" className="flex flex-col gap-om-10">
        <SectionTitle as="h2" size="sm" description={t('lifecycle.catalogue.subtitle')}>
          {t('lifecycle.catalogue.title')}
        </SectionTitle>
        {q.data === undefined ? (
          <QueryState status={q.isError ? 'error' : 'pending'} />
        ) : (
          <>
            <ul className="flex flex-col gap-om-4 text-om-xs text-om-secondary">
              {q.data.sources.map((s) => (
                <li key={s.source}>
                  {t('lifecycle.catalogue.source', {
                    source: s.source,
                    products: format.integer(s.products),
                    releases: format.integer(s.releases),
                    when: format.dateTime(s.fetchedAt),
                  })}
                </li>
              ))}
            </ul>
            {can(ROLES.admin) && q.data.syncAllowed ? (
              <span className="flex items-center gap-om-10">
                <Button
                  onClick={() => {
                    sync.mutate();
                  }}
                  disabled={sync.isPending}
                >
                  {t('lifecycle.catalogue.sync')}
                </Button>
                {sync.data !== undefined && sync.data.failed.length > 0 ? (
                  <span className="text-om-2xs text-om-state-degraded">
                    {t('lifecycle.catalogue.failed', { products: sync.data.failed.join(', ') })}
                  </span>
                ) : null}
                {sync.isError ? (
                  <span className="text-om-2xs text-om-state-down">{t('lifecycle.catalogue.syncError')}</span>
                ) : null}
              </span>
            ) : (
              <p className="text-om-2xs text-om-muted">{t('lifecycle.catalogue.syncOff')}</p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

export function LifecycleView({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const [tab, setTab] = useState<Tab>('os');
  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('app.name')}
        description={t('lifecycle.subtitle', { days: String(LIFECYCLE.endingDays) })}
      >
        {t('lifecycle.title')}
      </SectionTitle>
      <div
        role="tablist"
        aria-label={t('lifecycle.tabs')}
        className="flex gap-om-4 border-b border-om-border-glass"
      >
        {TABS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            onClick={() => {
              setTab(candidate);
            }}
            className={
              'border-b-2 px-om-14 py-om-10 text-om-sm font-medium ' +
              (tab === candidate
                ? 'border-om-cyan text-om-primary'
                : 'border-transparent text-om-secondary hover:text-om-primary')
            }
          >
            {t(('lifecycle.tab.' + candidate) as MessageKey)}
          </button>
        ))}
      </div>
      <Card padding="24" as="section" className="flex flex-col gap-om-16">
        {tab === 'os' ? <Releases kinds={['os']} locale={locale} /> : null}
        {tab === 'platforms' ? <Releases kinds={PLATFORM_KINDS} locale={locale} /> : null}
        {tab === 'hardware' ? <Hardware /> : null}
      </Card>
      <Catalogue />
    </div>
  );
}
