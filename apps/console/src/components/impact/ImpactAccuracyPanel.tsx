'use client';
// REQ-BSM-004 REQ-UI-013 (ADR-047) — prediction accuracy on the Impact screen: how well simulations of a root cause
// predicted the services real incidents hit (mean Jaccard accuracy, exact predictions, incidents awaiting validation),
// the latest validated incidents with what the model missed or over-predicted, and the relationships the misses
// suggest, which an operator accepts (the relationship is created) or dismisses.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ASSISTANT, BSM, IMPACT, ROLES } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import type { ReactNode } from 'react';
import { tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { useCan } from '@/lib/auth';
import { localizedHref } from '@/lib/locale-path';
import {
  decideSuggestion,
  impactAccuracyQuery,
  relationshipSuggestionsQuery,
  validateImpactPredictions,
  type CiSummary,
  type ImpactValidation,
} from '@/lib/queries';
import { useFormatters, useT } from '@/providers';

const primaryButton =
  'flex items-center gap-om-6 rounded-om-control-lg bg-om-cyan px-om-12 py-om-6 text-om-xs font-semibold text-om-ground transition-opacity duration-om-base hover:opacity-90 disabled:opacity-50';
const secondaryButton =
  'rounded-om-control-lg border border-om-border-strong px-om-12 py-om-6 text-om-xs font-semibold text-om-secondary transition-colors duration-om-base hover:text-om-primary disabled:opacity-50';

export interface ImpactAccuracyPanelProps {
  locale: Locale;
}

function CiLink({ locale, ci }: { locale: Locale; ci: CiSummary }): ReactNode {
  return (
    <Link
      href={localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id))}
      className="text-om-cyan hover:underline"
    >
      {ci.displayName}
    </Link>
  );
}

function Names({ locale, cis, empty }: { locale: Locale; cis: CiSummary[]; empty: string }): ReactNode {
  const t = useT();
  const format = useFormatters();
  if (cis.length === 0) return <span className="text-om-muted">{empty}</span>;
  // A shared component can predict every service of the estate: the first few are named, the rest counted.
  const shown = cis.slice(0, ASSISTANT.summaryNames);
  const more = cis.length - shown.length;
  return (
    <span className="flex flex-wrap gap-om-4">
      {shown.map((ci) => (
        <CiLink key={ci.id} locale={locale} ci={ci} />
      ))}
      {more > 0 ? (
        <span className="text-om-muted">{t('impact.andMore', { count: format.integer(more) })}</span>
      ) : null}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-om-2 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8">
      <span className="text-om-2xs uppercase tracking-wide text-om-muted">{label}</span>
      <span className="text-om-lg font-semibold text-om-primary">{value}</span>
    </div>
  );
}

export function ImpactAccuracyPanel({ locale }: ImpactAccuracyPanelProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const operator = can(ROLES.operator);
  const queryClient = useQueryClient();
  const accuracy = useQuery(impactAccuracyQuery(IMPACT.recentDefault));
  const suggestions = useQuery(relationshipSuggestionsQuery(IMPACT.suggestionsDefault));
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['impact-accuracy'] });
    void queryClient.invalidateQueries({ queryKey: ['relationship-suggestions'] });
  };
  const validate = useMutation({
    mutationFn: () => validateImpactPredictions(IMPACT.sweepBatch),
    onSuccess: refresh,
  });
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'accept' | 'dismiss' }) =>
      decideSuggestion(input.id, input.decision),
    onSuccess: refresh,
  });
  const percent = (value: number): string => format.percent(value * BSM.percentScale) + '%';

  return (
    <section aria-label={t('impact.accuracy.title')}>
      <Card className="flex flex-col gap-om-12">
        <SectionTitle
          as="h2"
          size="sm"
          description={t('impact.accuracy.description')}
          action={
            operator ? (
              <button
                type="button"
                className={primaryButton}
                disabled={validate.isPending}
                onClick={() => {
                  validate.mutate();
                }}
              >
                <Icon name="play" className="size-3" />
                {validate.isPending ? t('impact.accuracy.validating') : t('impact.accuracy.validate')}
              </button>
            ) : null
          }
        >
          {t('impact.accuracy.title')}
        </SectionTitle>
        {accuracy.isPending ? (
          <QueryState status="pending" />
        ) : accuracy.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void accuracy.refetch();
            }}
          />
        ) : (
          <>
            <div
              className="grid grid-cols-2 gap-om-8 md:grid-cols-5"
              role="group"
              aria-label={t('impact.accuracy.summary')}
            >
              <Stat
                label={t('impact.accuracy.mean')}
                value={
                  accuracy.data.meanAccuracy === null
                    ? t('impact.accuracy.none')
                    : percent(accuracy.data.meanAccuracy)
                }
              />
              <Stat label={t('impact.accuracy.validated')} value={format.integer(accuracy.data.validated)} />
              <Stat label={t('impact.accuracy.exact')} value={format.integer(accuracy.data.exact)} />
              <Stat label={t('impact.accuracy.pending')} value={format.integer(accuracy.data.pending)} />
              <Stat
                label={t('impact.accuracy.withoutRootCause')}
                value={format.integer(accuracy.data.withoutRootCause)}
              />
            </div>
            {accuracy.data.recent.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('impact.accuracy.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass} aria-label={t('impact.accuracy.recent')}>
                  <thead className={theadClass}>
                    <tr>
                      <th scope="col" className={thClass}>
                        {t('impact.accuracy.table.incident')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('impact.accuracy.table.rootCause')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('impact.accuracy.table.actual')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('impact.accuracy.table.missed')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('impact.accuracy.table.unexpected')}
                      </th>
                      <th scope="col" className={thClass}>
                        {t('impact.accuracy.table.accuracy')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {accuracy.data.recent.map((v: ImpactValidation) => (
                      <tr key={v.incident.id}>
                        <td className={tdClass}>
                          <span className="block font-medium text-om-primary">{v.incident.title}</span>
                          {v.incident.resolvedAt !== null ? (
                            <span className="block text-om-2xs text-om-muted">
                              {format.dateTime(v.incident.resolvedAt)}
                            </span>
                          ) : null}
                        </td>
                        <td className={tdClass}>
                          {v.rootCause === null ? (
                            <span className="text-om-muted">{t('impact.accuracy.none')}</span>
                          ) : (
                            <CiLink locale={locale} ci={v.rootCause} />
                          )}
                        </td>
                        <td className={tdClass}>
                          <Names locale={locale} cis={v.actualServices} empty={t('impact.accuracy.none')} />
                        </td>
                        <td className={tdClass}>
                          <Names locale={locale} cis={v.missedServices} empty={t('impact.accuracy.none')} />
                        </td>
                        <td className={tdClass}>
                          <Names
                            locale={locale}
                            cis={v.unexpectedServices}
                            empty={t('impact.accuracy.none')}
                          />
                        </td>
                        <td className={tdClass}>
                          <Tag>{percent(v.accuracy)}</Tag>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        <SectionTitle as="h3" size="sm">
          {t('impact.suggestions.title')}
        </SectionTitle>
        {suggestions.isPending ? (
          <QueryState status="pending" />
        ) : suggestions.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void suggestions.refetch();
            }}
          />
        ) : suggestions.data.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('impact.suggestions.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-om-6" aria-label={t('impact.suggestions.title')}>
            {suggestions.data.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8 text-om-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-om-primary">
                    {t('impact.suggestions.edge', { from: s.from.displayName, to: s.to.displayName })}
                  </span>
                  <span className="block text-om-2xs text-om-muted">
                    {t('impact.suggestions.seen', { count: format.integer(s.occurrences) })}
                    {s.lastIncident !== null
                      ? ' · ' + t('impact.suggestions.last', { incident: s.lastIncident.title })
                      : ''}
                  </span>
                </span>
                {operator ? (
                  <span className="flex gap-om-6">
                    <button
                      type="button"
                      className={primaryButton}
                      disabled={decide.isPending}
                      onClick={() => {
                        decide.mutate({ id: s.id, decision: 'accept' });
                      }}
                    >
                      {t('impact.suggestions.accept')}
                    </button>
                    <button
                      type="button"
                      className={secondaryButton}
                      disabled={decide.isPending}
                      onClick={() => {
                        decide.mutate({ id: s.id, decision: 'dismiss' });
                      }}
                    >
                      {t('impact.suggestions.dismiss')}
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {decide.isError || validate.isError ? (
          <p role="alert" className="text-om-xs text-om-state-down">
            {t('common.error')}
          </p>
        ) : null}
      </Card>
    </section>
  );
}
