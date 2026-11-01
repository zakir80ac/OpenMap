'use client';
// REQ-UI-008 REQ-CMDB-037 REQ-CMDB-038 REQ-CMDB-012 — CI detail: header (code, name, type, layer, health, headline
// metric, lifecycle, source, observed), tabs Overview (identity, attributes, tags, external ids), Relationships (grouped by type, each row a
// link), Impact (upstream and downstream counts linking into the dependency map) and History (time travel: `asOf`
// re-fetches `ci(id, asOf)` and the attribute diff against now). Unknown-layer CIs get the "Label this CI" panel.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { GRAPH, ROLES } from '@openmap/constants';
import { CI_CODE_PATTERN } from '@openmap/contracts';
import type { Locale } from '@openmap/i18n';
import { Card, LayerBadge, Pill, SectionTitle, StateBadge, Tag, cx } from '@openmap/ui';
import { useId, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, TextInput } from '@/components/common/controls';
import { HeadlineMetric } from '@/components/common/HeadlineMetric';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import {
  diffAttributes,
  groupRelationships,
  stableStringify,
  valueKind,
  type AttributeChange,
} from '@/lib/attributes';
import { useCan } from '@/lib/auth';
import { relationshipColor } from '@/lib/graph-layout';
import { healthKey, layerKey, relationshipKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import {
  ciDetailQuery,
  impactQuery,
  setCiCode,
  type CiDetail,
  type CiSummary,
  type ImpactDirection,
  type JsonValue,
} from '@/lib/queries';
import { toAsOf, toLocalInput } from '@/lib/time-travel';
import { useFormatters, useT, type Translate } from '@/providers';
import type { Formatters } from '@/lib/format';
import { LabelCiPanel } from './LabelCiPanel';

export interface CiDetailViewProps {
  locale: Locale;
  id: string;
}

const TABS = ['overview', 'relationships', 'impact', 'history'] as const;
type Tab = (typeof TABS)[number];

const lifecycleKey = {
  discovered: 'lifecycle.discovered',
  managed: 'lifecycle.managed',
  planned: 'lifecycle.planned',
  retired: 'lifecycle.retired',
} as const;

const changeKey = {
  added: 'cmdb.detail.history.change.added',
  removed: 'cmdb.detail.history.change.removed',
  changed: 'cmdb.detail.history.change.changed',
} as const satisfies Record<AttributeChange, string>;

const changeState = { added: 'healthy', removed: 'down', changed: 'degraded' } as const;

/** One attribute value, formatted for the active locale by its kind. */
function ValueCell({
  value,
  t,
  format,
}: {
  value: JsonValue | undefined;
  t: Translate;
  format: Formatters;
}): ReactNode {
  switch (valueKind(value)) {
    case 'null':
      return <span className="text-om-muted">{t('common.none')}</span>;
    case 'boolean':
      return <span>{value === true ? t('common.yes') : t('common.no')}</span>;
    case 'number':
      return <span className="font-om-mono tabular-nums">{format.number(value as number)}</span>;
    case 'date':
      return <time dateTime={value as string}>{format.dateTime(value as string)}</time>;
    case 'list':
      return (
        <span className="flex flex-wrap gap-om-4">
          {(value as JsonValue[]).map((item, index) => (
            <Tag key={String(index)}>{typeof item === 'object' ? JSON.stringify(item) : String(item)}</Tag>
          ))}
        </span>
      );
    case 'object':
      return (
        <code className="whitespace-pre-wrap break-all font-om-mono text-om-2xs text-om-secondary">
          {JSON.stringify(value)}
        </code>
      );
    case 'text':
      return (
        <span className="break-words">{typeof value === 'string' ? value : stableStringify(value)}</span>
      );
  }
}

function KeyValueGrid({
  entries,
  t,
  format,
}: {
  entries: Array<[string, JsonValue]>;
  t: Translate;
  format: Formatters;
}): ReactNode {
  return (
    <dl className="grid grid-cols-1 gap-x-om-16 gap-y-om-8 text-om-sm md:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="truncate font-om-mono text-om-xs text-om-secondary">{key}</dt>
          <dd className="min-w-0 text-om-primary">
            <ValueCell value={value} t={t} format={format} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ciHref(locale: Locale, ci: Pick<CiSummary, 'id'>): string {
  return localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id));
}

function mapHref(locale: Locale, id: string, direction: ImpactDirection): string {
  const params = new URLSearchParams({ ci: id });
  if (direction !== 'upstream') params.set('direction', direction);
  return localizedHref(locale, '/dependencies') + '?' + params.toString();
}

function ImpactSummaryCard({
  locale,
  id,
  direction,
}: {
  locale: Locale;
  id: string;
  direction: ImpactDirection;
}): ReactNode {
  const t = useT();
  const format = useFormatters();
  const impact = useQuery(
    impactQuery({ ciId: id, direction, maxDepth: GRAPH.defaultImpactDepth, asOf: null }),
  );
  return (
    <Card as="section" className="flex flex-col gap-om-12">
      <SectionTitle
        as="h3"
        size="sm"
        description={t('cmdb.detail.impact.hint', { count: format.integer(GRAPH.defaultImpactDepth) })}
      >
        {t(direction === 'upstream' ? 'cmdb.detail.impact.upstream' : 'cmdb.detail.impact.downstream')}
      </SectionTitle>
      {impact.isPending ? (
        <QueryState status="pending" />
      ) : impact.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void impact.refetch();
          }}
        />
      ) : (
        <div className="flex flex-wrap items-end gap-om-16">
          <div>
            <p className="font-om-display text-om-3xl font-extrabold text-om-primary">
              {format.integer(impact.data.nodes.length)}
            </p>
            <p className="text-om-2xs text-om-secondary">
              {t('cmdb.detail.impact.nodes', { count: format.integer(impact.data.nodes.length) })}
            </p>
          </div>
          <div>
            <p
              className={cx(
                'font-om-display text-om-3xl font-extrabold',
                impact.data.services.length > 0 ? 'text-om-rose' : 'text-om-primary',
              )}
            >
              {format.integer(impact.data.services.length)}
            </p>
            <p className="text-om-2xs text-om-secondary">
              {t('cmdb.detail.impact.services', { count: format.integer(impact.data.services.length) })}
            </p>
          </div>
          <Link href={mapHref(locale, id, direction)} className="ms-auto">
            <Pill variant="primary" icon={<Icon name="dependencies" className="size-3.5" />}>
              {t('cmdb.detail.impact.open')}
            </Pill>
          </Link>
        </div>
      )}
    </Card>
  );
}

function HistoryTab({ ci }: { ci: CiDetail }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const [asOf, setAsOf] = useState<string | undefined>(undefined);
  const then = useQuery({ ...ciDetailQuery(ci.id, asOf ?? null), enabled: asOf !== undefined });
  const rows = useMemo(
    () =>
      then.data === undefined || then.data === null
        ? []
        : diffAttributes(then.data.attributes, ci.attributes),
    [then.data, ci.attributes],
  );

  return (
    <Card as="section" className="flex flex-col gap-om-14">
      <SectionTitle
        as="h3"
        size="sm"
        description={t('cmdb.detail.history.hint')}
        action={<Icon name="clock" className="size-5 text-om-violet" />}
      >
        {t('cmdb.detail.history.title')}
      </SectionTitle>
      <label className="flex flex-col gap-om-4 md:max-w-sm">
        <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
          {t('cmdb.detail.history.asOf')}
        </span>
        <input
          type="datetime-local"
          value={toLocalInput(asOf)}
          onChange={(event) => {
            setAsOf(toAsOf(event.target.value));
          }}
          className="h-10 rounded-om-control-lg border border-om-violet/40 bg-om-surface1/80 px-om-10 text-om-sm text-om-primary outline-none focus:shadow-om-glow-bar-violet"
        />
      </label>
      {asOf === undefined ? (
        <p className="text-om-sm text-om-secondary">{t('cmdb.detail.history.pick')}</p>
      ) : then.isPending ? (
        <QueryState status="pending" />
      ) : then.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void then.refetch();
          }}
        />
      ) : then.data === null ? (
        <QueryState status="empty" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-om-8">
            <Pill variant="time-travel" icon={<Icon name="clock" className="size-3.5" />}>
              {format.dateTime(asOf)}
            </Pill>
            <Tag>{t('cmdb.detail.history.thenVersion', { from: format.dateTime(then.data.validFrom) })}</Tag>
            <Tag>{t('cmdb.detail.history.changes', { count: format.integer(rows.length) })}</Tag>
          </div>
          {rows.length === 0 ? (
            <p className="text-om-sm text-om-secondary">
              {t('cmdb.detail.history.noChanges', { when: format.dateTime(asOf) })}
            </p>
          ) : (
            <table className="w-full border-collapse text-om-sm">
              <thead>
                <tr className="border-b border-om-border-glass text-start text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                  <th scope="col" className="py-om-6 text-start">
                    {t('cmdb.detail.history.column.attribute')}
                  </th>
                  <th scope="col" className="py-om-6 text-start">
                    {t('cmdb.detail.history.column.then')}
                  </th>
                  <th scope="col" className="py-om-6 text-start">
                    {t('cmdb.detail.history.column.now')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b border-om-border-glass align-top last:border-b-0">
                    <th
                      scope="row"
                      className="py-om-8 pe-om-12 text-start font-om-mono text-om-xs font-medium text-om-secondary"
                    >
                      <span className="flex flex-col items-start gap-om-4">
                        {row.key}
                        <Tag variant="state" state={changeState[row.change]}>
                          {t(changeKey[row.change])}
                        </Tag>
                      </span>
                    </th>
                    <td className="py-om-8 pe-om-12 text-om-secondary">
                      <ValueCell value={row.before} t={t} format={format} />
                    </td>
                    <td className="py-om-8 text-om-primary">
                      <ValueCell value={row.after} t={t} format={format} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Card>
  );
}

export function CiDetailView({ locale, id }: CiDetailViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const [tab, setTab] = useState<Tab>('overview');
  const query = useQuery(ciDetailQuery(id));

  if (query.isPending) {
    return (
      <Card>
        <QueryState status="pending" />
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card>
        <QueryState
          status="error"
          onRetry={() => {
            void query.refetch();
          }}
        />
      </Card>
    );
  }
  const ci = query.data;
  if (ci === null) {
    return (
      <Card>
        <QueryState status="empty" />
        <p className="mt-om-10 text-om-sm text-om-secondary">{t('cmdb.detail.notFound', { id })}</p>
      </Card>
    );
  }

  const attributes = Object.entries(ci.attributes).sort(([a], [b]) => a.localeCompare(b));
  const identity = Object.entries(ci.identity);
  const relationships = ci.relationships.edges.map((edge) => edge.node);
  const groups = groupRelationships(relationships, ci.id);

  return (
    <div className="flex flex-col gap-om-20">
      <nav aria-label={t('nav.cmdb')} className="text-om-xs text-om-muted">
        <Link href={localizedHref(locale, '/cmdb')} className="hover:text-om-primary">
          {t('nav.cmdb')}
        </Link>
        <span aria-hidden="true"> › </span>
        <span>{t(layerKey(ci.layer))}</span>
      </nav>

      <header className="flex flex-wrap items-start gap-om-16">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-om-8 font-om-mono text-om-xs text-om-cyan">
            <span className="text-om-muted">{t('cmdb.detail.code')}</span>
            <CodeField ci={ci} />
          </p>
          <h1 className="truncate font-om-display text-om-3xl font-extrabold tracking-om-display-tight text-om-primary">
            {ci.displayName}
          </h1>
          <p className="flex flex-wrap items-center gap-x-om-12 gap-y-om-4 text-om-sm text-om-secondary">
            <span className="font-om-mono">{ci.type}</span>
            <span>
              {t('cmdb.detail.source', {
                collector: ci.source.collectorId,
                confidence: format.number(ci.source.confidence),
              })}
            </span>
            <span>{t('cmdb.detail.observed', { when: format.dateTime(ci.observedAt) })}</span>
          </p>
        </div>
        <HeadlineMetric metric={ci.headlineMetric} variant="card" className="min-w-28 items-end text-end" />
        <div className="flex flex-wrap items-center gap-om-8">
          <LayerBadge layer={ci.layer} label={t(layerKey(ci.layer))} />
          <StateBadge state={ci.health} label={t(healthKey[ci.health])} live={ci.health !== 'healthy'} />
          <Tag>{t(lifecycleKey[ci.lifecycle])}</Tag>
          {ci.userLabel !== null ? (
            <Tag>
              {t('cmdb.detail.userLabel', { title: ci.userLabel.title, by: ci.userLabel.labelledBy })}
            </Tag>
          ) : null}
          <Link href={mapHref(locale, ci.id, 'upstream')}>
            <Pill variant="primary" icon={<Icon name="dependencies" className="size-3.5" />}>
              {t('action.viewImpact')}
            </Pill>
          </Link>
        </div>
      </header>

      {ci.layer === 'unknown' ? <LabelCiPanel ci={ci} /> : null}

      <div
        role="tablist"
        aria-label={t('cmdb.detail.tabs')}
        className="flex gap-om-4 border-b border-om-border-glass"
      >
        {TABS.map((candidate) => {
          const selected = candidate === tab;
          const count =
            candidate === 'relationships'
              ? ci.relationships.totalCount
              : candidate === 'overview'
                ? attributes.length
                : undefined;
          return (
            <button
              key={candidate}
              type="button"
              role="tab"
              id={'tab-' + candidate}
              aria-selected={selected}
              aria-controls={'panel-' + candidate}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                setTab(candidate);
              }}
              className={cx(
                'flex items-center gap-om-8 border-b-2 px-om-14 py-om-10 text-om-sm font-medium transition-colors duration-om-base ease-om-standard',
                selected
                  ? 'border-om-cyan text-om-primary'
                  : 'border-transparent text-om-secondary hover:text-om-primary',
              )}
            >
              {t(`cmdb.detail.tab.${candidate}`)}
              {count !== undefined ? (
                <span className="rounded-om-pill bg-om-surface3 px-om-6 text-om-2xs text-om-secondary">
                  {format.integer(count)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={'panel-' + tab}
        aria-labelledby={'tab-' + tab}
        className="flex flex-col gap-om-16"
      >
        {tab === 'overview' ? (
          <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-2">
            <Card as="section" className="flex flex-col gap-om-12">
              <SectionTitle as="h2" size="sm" description={t('cmdb.detail.identityHint')}>
                {t('cmdb.detail.identity')}
              </SectionTitle>
              <KeyValueGrid entries={identity} t={t} format={format} />
              <dl className="grid grid-cols-1 gap-x-om-16 gap-y-om-8 border-t border-om-border-glass pt-om-12 text-om-sm md:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                <dt className="font-om-mono text-om-xs text-om-secondary">
                  {t('cmdb.detail.node', { node: '' }).trim()}
                </dt>
                <dd className="font-om-mono text-om-xs text-om-primary">{ci.source.nodeId}</dd>
                <dt className="font-om-mono text-om-xs text-om-secondary">
                  {t('cmdb.detail.run', { run: '' }).trim()}
                </dt>
                <dd className="font-om-mono text-om-xs text-om-primary">{ci.source.runId}</dd>
                <dt className="font-om-mono text-om-xs text-om-secondary">
                  {t('cmdb.detail.validFrom', { when: '' }).trim()}
                </dt>
                <dd className="text-om-primary">{format.dateTime(ci.validFrom)}</dd>
              </dl>
            </Card>
            <Card as="section" className="flex flex-col gap-om-12">
              <SectionTitle
                as="h2"
                size="sm"
                description={t('cmdb.detail.attributesCount', { count: format.integer(attributes.length) })}
              >
                {t('cmdb.detail.attributes')}
              </SectionTitle>
              {attributes.length === 0 ? (
                <p className="text-om-sm text-om-secondary">{t('cmdb.detail.noAttributes')}</p>
              ) : (
                <KeyValueGrid entries={attributes} t={t} format={format} />
              )}
            </Card>
            <Card as="section" className="flex flex-col gap-om-12">
              <SectionTitle as="h2" size="sm">
                {t('cmdb.detail.tags')}
              </SectionTitle>
              {ci.tags.length === 0 ? (
                <p className="text-om-sm text-om-secondary">{t('cmdb.detail.noTags')}</p>
              ) : (
                <ul className="flex flex-wrap gap-om-6">
                  {ci.tags.map((tag) => (
                    <li key={tag}>
                      <Tag>{tag}</Tag>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card as="section" className="flex flex-col gap-om-12">
              <SectionTitle as="h2" size="sm">
                {t('cmdb.detail.externalIds')}
              </SectionTitle>
              {ci.externalIds.length === 0 ? (
                <p className="text-om-sm text-om-secondary">{t('cmdb.detail.noExternalIds')}</p>
              ) : (
                <ul className="flex flex-col gap-om-6 text-om-sm">
                  {ci.externalIds.map((external) => (
                    <li key={external.source + ':' + external.id} className="flex items-center gap-om-10">
                      <Tag>{external.source}</Tag>
                      <span className="truncate font-om-mono text-om-xs text-om-primary">{external.id}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        ) : null}

        {tab === 'relationships' ? (
          <Card as="section" className="flex flex-col gap-om-14">
            <SectionTitle
              as="h2"
              size="sm"
              description={t('cmdb.detail.relationships.shown', {
                shown: format.integer(relationships.length),
                total: format.integer(ci.relationships.totalCount),
              })}
            >
              {t('cmdb.detail.relationships.count', { count: format.integer(ci.relationships.totalCount) })}
            </SectionTitle>
            {groups.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('cmdb.detail.relationships.none')}</p>
            ) : (
              groups.map((group) => (
                <section key={group.type} className="flex flex-col gap-om-6">
                  <h3 className="flex items-center gap-om-8 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 rounded-om-pill"
                      style={{ background: relationshipColor(group.type) }}
                    />
                    {t(relationshipKey(group.type))}
                    <span className="rounded-om-pill bg-om-surface3 px-om-6 text-om-secondary">
                      {format.integer(group.rows.length)}
                    </span>
                  </h3>
                  <ul className="flex flex-col gap-om-6">
                    {group.rows.map(({ row, other, outgoing }) => (
                      <li
                        key={row.id}
                        className="flex items-center gap-om-12 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-12 py-om-8 text-om-sm"
                      >
                        <span className="w-20 shrink-0 text-om-2xs text-om-muted">
                          {t(
                            outgoing
                              ? 'cmdb.detail.relationships.outgoing'
                              : 'cmdb.detail.relationships.incoming',
                          )}
                        </span>
                        <Link
                          href={ciHref(locale, other)}
                          className="min-w-0 flex-1 truncate font-medium text-om-primary hover:text-om-cyan"
                        >
                          {other.displayName}
                        </Link>
                        <span className="truncate font-om-mono text-om-2xs text-om-muted">{other.type}</span>
                        <LayerBadge layer={other.layer} label={t(layerKey(other.layer))} />
                        <StateBadge state={other.health} label={t(healthKey[other.health])} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </Card>
        ) : null}

        {tab === 'impact' ? (
          <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-2">
            <ImpactSummaryCard locale={locale} id={ci.id} direction="upstream" />
            <ImpactSummaryCard locale={locale} id={ci.id} direction="downstream" />
          </div>
        ) : null}

        {tab === 'history' ? <HistoryTab ci={ci} /> : null}
      </div>
    </div>
  );
}

interface CodeFieldProps {
  ci: CiDetail;
}

/** REQ-CMDB-037 — the stored short code; operators rename it in place (setCiCode), everyone else reads it. */
function CodeField({ ci }: CodeFieldProps): ReactNode {
  const t = useT();
  const can = useCan();
  const queryClient = useQueryClient();
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(ci.code);
  const mutation = useMutation({
    mutationFn: (code: string) => setCiCode(ci.id, code),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['ci', ci.id] });
      await queryClient.invalidateQueries({ queryKey: ['cis'] });
    },
  });
  const candidate = value.trim().toUpperCase();
  const valid = CI_CODE_PATTERN.test(candidate);
  if (!editing) {
    return (
      <>
        <span>{ci.code}</span>
        {can(ROLES.operator) ? (
          <Button
            tone="quiet"
            className="text-om-2xs"
            onClick={() => {
              setValue(ci.code);
              mutation.reset();
              setEditing(true);
            }}
          >
            {t('cmdb.detail.code.edit')}
          </Button>
        ) : null}
      </>
    );
  }
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!valid || candidate === ci.code) return;
    mutation.mutate(candidate);
  };
  return (
    <form
      onSubmit={onSubmit}
      aria-label={t('cmdb.detail.code.form')}
      className="flex flex-wrap items-center gap-om-6"
    >
      <TextInput
        id={inputId}
        aria-label={t('cmdb.detail.code.label')}
        aria-invalid={!valid}
        value={value}
        autoFocus
        onChange={(event) => {
          setValue(event.target.value);
        }}
        className="w-auto font-om-mono uppercase"
      />
      <Button type="submit" disabled={!valid || mutation.isPending}>
        {mutation.isPending ? t('cmdb.detail.code.saving') : t('action.save')}
      </Button>
      <Button
        tone="quiet"
        onClick={() => {
          setEditing(false);
        }}
      >
        {t('action.cancel')}
      </Button>
      <span className="text-om-2xs text-om-muted">{t('cmdb.detail.code.hint')}</span>
      {mutation.isError ? (
        <span role="alert" className="text-om-2xs text-om-rose">
          {t('cmdb.detail.code.error')}
        </span>
      ) : null}
    </form>
  );
}
