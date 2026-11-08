'use client';
// REQ-AI-003 (ADR-053) — Anomalies: the findings of the rules over discovery and health events (an address two CIs
// claim, an unmanaged device in a data centre, a flapping service), open first, each with its subject, the facts the
// rule found, when it was detected and last seen, and the local model's explanation on demand. Operators can run the
// rules now; they also run on the API's interval.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ANOMALY, ROLES } from '@openmap/constants';
import { ANOMALY_RULES, type AnomalyRule } from '@openmap/contracts';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import { useState, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { anomaliesKey, anomaliesQuery, detectAnomalies, explainAnomaly, type AnomalyFinding } from '@/lib/anomaly-queries';
import { useCan } from '@/lib/auth';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

const primaryButton =
  'rounded-om-control-lg bg-om-cyan px-om-12 py-om-6 text-om-xs font-semibold text-om-ground transition-opacity duration-om-base hover:opacity-90 disabled:opacity-50';
const secondaryButton =
  'rounded-om-control-lg border border-om-border-strong px-om-10 py-om-4 text-om-xs font-semibold text-om-secondary transition-colors duration-om-base hover:text-om-primary disabled:opacity-50';

const RULE_KEY = {
  ip_conflict: 'anomaly.rule.ip_conflict',
  unmanaged_device_in_datacenter: 'anomaly.rule.unmanaged_device_in_datacenter',
  flapping_service: 'anomaly.rule.flapping_service',
} as const satisfies Record<AnomalyRule, MessageKey>;
const RULE_HINT = {
  ip_conflict: 'anomaly.rule.ip_conflict.hint',
  unmanaged_device_in_datacenter: 'anomaly.rule.unmanaged_device_in_datacenter.hint',
  flapping_service: 'anomaly.rule.flapping_service.hint',
} as const satisfies Record<AnomalyRule, MessageKey>;
const FACT_KEY: Record<string, MessageKey> = {
  address: 'anomaly.fact.address',
  claimants: 'anomaly.fact.claimants',
  device: 'anomaly.fact.device',
  site: 'anomaly.fact.site',
  vendor: 'anomaly.fact.vendor',
  firstSeen: 'anomaly.fact.firstSeen',
  service: 'anomaly.fact.service',
  changes: 'anomaly.fact.changes',
  windowHours: 'anomaly.fact.windowHours',
  from: 'anomaly.fact.from',
  to: 'anomaly.fact.to',
};
/** Facts holding an instant, shown in the reader's format. */
const TIME_FACTS: ReadonlySet<string> = new Set(['firstSeen', 'from', 'to']);

export function AnomaliesView({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const operator = useCan()(ROLES.operator);
  const queryClient = useQueryClient();
  const report = useQuery(anomaliesQuery(ANOMALY.screenRefreshMs));
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const detect = useMutation({
    mutationFn: detectAnomalies,
    onSuccess: (data) => {
      queryClient.setQueryData(anomaliesKey, data);
    },
  });
  const explain = useMutation({
    mutationFn: (id: string) => explainAnomaly(id, locale),
    onSuccess: (text, id) => {
      if (text !== null) setExplanations((current) => ({ ...current, [id]: text }));
    },
  });
  const factValue = (key: string, value: string): string => (TIME_FACTS.has(key) && !Number.isNaN(Date.parse(value)) ? format.dateTime(value) : value);
  const factLabel = (key: string): string => {
    const label = FACT_KEY[key];
    return label === undefined ? key : t(label);
  };
  const explanationOf = (f: AnomalyFinding): string | null => explanations[f.id] ?? (f.explanationLocale === locale ? f.explanation : null);

  return (
    <div className="flex flex-col gap-om-16">
      <SectionTitle
        as="h1"
        size="lg"
        description={t('anomaly.description')}
        action={
          operator ? (
            <button
              type="button"
              className={primaryButton}
              disabled={detect.isPending}
              onClick={() => {
                detect.mutate();
              }}
            >
              {detect.isPending ? t('anomaly.detecting') : t('anomaly.detect')}
            </button>
          ) : null
        }
      >
        {t('nav.anomalies')}
      </SectionTitle>
      {report.isPending ? (
        <QueryState status="pending" />
      ) : report.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void report.refetch();
          }}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-om-8 md:grid-cols-4" role="group" aria-label={t('anomaly.summary')}>
            {[
              [t('anomaly.summary.open'), format.integer(report.data.open)],
              ...ANOMALY_RULES.map((rule) => [t(RULE_KEY[rule]), format.integer(report.data.findings.filter((f) => f.rule === rule && f.state === 'open').length)] as const),
            ].map(([label, value]) => (
              <Card key={label} padding="12" className="flex flex-col gap-om-2">
                <span className="text-om-2xs uppercase tracking-wide text-om-muted">{label}</span>
                <span className="text-om-lg font-semibold text-om-primary">{value}</span>
              </Card>
            ))}
          </div>
          <p className="text-om-2xs text-om-muted">
            {report.data.lastSweepAt === null ? t('anomaly.notSwept') : t('anomaly.lastSweep', { when: format.dateTime(report.data.lastSweepAt) })}
          </p>
          {report.data.findings.length === 0 ? (
            <Card>
              <p className="text-om-sm text-om-secondary">{t('anomaly.empty')}</p>
            </Card>
          ) : (
            <ul className="flex flex-col gap-om-8" aria-label={t('anomaly.list')}>
              {report.data.findings.map((f) => {
                const text = explanationOf(f);
                return (
                  <li key={f.id} aria-label={t(RULE_KEY[f.rule])}>
                    <Card className="flex flex-col gap-om-6">
                      <div className="flex flex-wrap items-center gap-om-8">
                        <Tag variant="state" state={f.state === 'open' ? 'down' : 'healthy'}>
                          {f.state === 'open' ? t('anomaly.state.open') : t('anomaly.state.cleared')}
                        </Tag>
                        <span className="font-medium text-om-primary">{t(RULE_KEY[f.rule])}</span>
                        {f.subject !== null ? (
                          <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(f.subject.id))} className="text-om-cyan hover:underline">
                            {f.subject.displayName}
                          </Link>
                        ) : null}
                        <span className="ms-auto text-om-2xs text-om-muted">
                          {f.state === 'open'
                            ? t('anomaly.since', { when: format.dateTime(f.detectedAt) })
                            : t('anomaly.clearedAt', { when: format.dateTime(f.clearedAt ?? f.lastSeenAt) })}
                        </span>
                      </div>
                      <p className="text-om-2xs text-om-muted">{t(RULE_HINT[f.rule])}</p>
                      <dl className="flex flex-wrap gap-x-om-12 gap-y-om-4 text-om-xs" aria-label={t('anomaly.facts')}>
                        {f.facts.map((fact) => (
                          <div key={fact.key} className="flex gap-om-4">
                            <dt className="text-om-muted">{factLabel(fact.key)}</dt>
                            <dd dir="auto" className="text-om-primary">
                              {factValue(fact.key, fact.value)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {text !== null ? (
                        <p className="rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8 text-om-sm text-om-secondary" aria-label={t('anomaly.explanation')}>
                          {text}
                        </p>
                      ) : (
                        <div>
                          <button
                            type="button"
                            className={secondaryButton}
                            disabled={explain.isPending && explain.variables === f.id}
                            onClick={() => {
                              explain.mutate(f.id);
                            }}
                          >
                            {explain.isPending && explain.variables === f.id ? t('anomaly.explaining') : t('anomaly.explain')}
                          </button>
                          {explain.isError && explain.variables === f.id ? (
                            <span role="alert" className="ms-om-8 text-om-xs text-om-state-down">
                              {t('anomaly.explainFailed')}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
          {detect.isError ? (
            <p role="alert" className="text-om-xs text-om-state-down">
              {t('common.error')}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
