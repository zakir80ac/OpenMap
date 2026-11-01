'use client';
// REQ-UI-016 REQ-CMDB-035 REQ-SEC-008 — Vulnerabilities: every CVE correlated to installed software, ranked by CVSS
// and filtered by CVSS floor, exploitation in the wild and internet exposure. Selecting a CVE walks the graph for its
// blast radius: the software it affects, the hosts carrying that software and the business services those hosts
// hold up, each with the state the layer model predicts if the vulnerability is exploited.
import { useQuery } from '@tanstack/react-query';
import { VULNERABILITY } from '@openmap/constants';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, StateBadge, Tag, type UiState } from '@openmap/ui';
import Link from 'next/link';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Select, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { localizedHref } from '@/lib/locale-path';
import { vulnerabilitiesQuery, vulnerabilityQuery, type VulnerabilitySummary } from '@/lib/software-queries';
import { useFormatters, useT } from '@/providers';

export interface VulnerabilitiesViewProps {
  locale: Locale;
}

export type Exposure = '' | 'internet' | 'internal';

const SEVERITY_STATE: Record<string, UiState> = {
  critical: 'down',
  high: 'degraded',
  medium: 'at_risk',
  low: 'unknown',
};

/** Badge state for a vendor severity word; anything unrecognised reads as unknown. */
export function severityState(severity: string): UiState {
  return SEVERITY_STATE[severity.toLowerCase()] ?? 'unknown';
}

function severityKey(severity: string): MessageKey {
  const known = severity.toLowerCase() in SEVERITY_STATE ? severity.toLowerCase() : 'unknown';
  return ('vulnerabilities.severity.' + known) as MessageKey;
}

export interface VulnerabilityHeadline {
  critical: number;
  exploited: number;
  internetFacing: number;
}

/** Headline counts over the listed CVEs: critical by CVSS, exploited in the wild, reachable from the internet. */
export function headline(list: ReadonlyArray<VulnerabilitySummary>): VulnerabilityHeadline {
  let critical = 0;
  let exploited = 0;
  let internetFacing = 0;
  for (const v of list) {
    if (v.cvss >= VULNERABILITY.criticalCvssMin) critical += 1;
    if (v.exploited) exploited += 1;
    if (v.internetFacing) internetFacing += 1;
  }
  return { critical, exploited, internetFacing };
}

export function exposureFilter(exposure: Exposure): boolean | null {
  return exposure === '' ? null : exposure === 'internet';
}

export function VulnerabilitiesView({ locale }: VulnerabilitiesViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const [minCvss, setMinCvss] = useState(0);
  const [exploitedOnly, setExploitedOnly] = useState(false);
  const [exposure, setExposure] = useState<Exposure>('');
  const [selected, setSelected] = useState<string | null>(null);
  const summaries = useQuery(
    vulnerabilitiesQuery({
      minCvss: minCvss === 0 ? null : minCvss,
      exploitedOnly,
      internetFacing: exposureFilter(exposure),
    }),
  );
  const detail = useQuery({ ...vulnerabilityQuery(selected ?? ''), enabled: selected !== null });
  const list = summaries.data ?? [];
  const counts = useMemo(() => headline(list), [list]);
  const ciHref = (ciId: string): string => localizedHref(locale, '/cmdb/' + encodeURIComponent(ciId));

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('vulnerabilities.subtitle')}>
        {t('vulnerabilities.title')}
      </SectionTitle>

      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-4">
        <Kpi label={t('vulnerabilities.kpi.shown')} value={format.integer(list.length)} />
        <Kpi
          label={t('vulnerabilities.kpi.critical')}
          value={format.integer(counts.critical)}
          delta={counts.critical}
          deltaLabel=""
          lowerIsBetter
        />
        <Kpi
          label={t('vulnerabilities.kpi.exploited')}
          value={format.integer(counts.exploited)}
          delta={counts.exploited}
          deltaLabel=""
          lowerIsBetter
        />
        <Kpi
          label={t('vulnerabilities.kpi.internetFacing')}
          value={format.integer(counts.internetFacing)}
          delta={counts.internetFacing}
          deltaLabel=""
          lowerIsBetter
        />
      </div>

      <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[3fr_2fr]">
        <Card padding="24" className="flex flex-col gap-om-16">
          <SectionTitle
            as="h2"
            size="sm"
            description={t('vulnerabilities.list.subtitle')}
            action={
              <div className="flex flex-wrap items-center gap-om-10 text-om-xs text-om-secondary">
                <label className="flex items-center gap-om-6">
                  <span>{t('vulnerabilities.filter.minCvss')}</span>
                  <Select
                    id={id + '-cvss'}
                    value={minCvss}
                    onChange={(event) => {
                      setMinCvss(Number(event.target.value));
                    }}
                    className="w-auto"
                  >
                    <option value={0}>{t('vulnerabilities.filter.anyCvss')}</option>
                    {VULNERABILITY.cvssFilterSteps.map((score) => (
                      <option key={score} value={score}>
                        {t('vulnerabilities.filter.cvssAtLeast', { score: format.number(score) })}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex items-center gap-om-6">
                  <span>{t('vulnerabilities.filter.exposure')}</span>
                  <Select
                    id={id + '-exposure'}
                    value={exposure}
                    onChange={(event) => {
                      setExposure(event.target.value as Exposure);
                    }}
                    className="w-auto"
                  >
                    <option value="">{t('vulnerabilities.filter.exposure.any')}</option>
                    <option value="internet">{t('vulnerabilities.filter.exposure.internet')}</option>
                    <option value="internal">{t('vulnerabilities.filter.exposure.internal')}</option>
                  </Select>
                </label>
                <label className="flex items-center gap-om-6">
                  <input
                    type="checkbox"
                    checked={exploitedOnly}
                    onChange={(event) => {
                      setExploitedOnly(event.target.checked);
                    }}
                  />
                  <span>{t('vulnerabilities.filter.exploitedOnly')}</span>
                </label>
              </div>
            }
          >
            {t('vulnerabilities.list.title')}
          </SectionTitle>
          {summaries.isPending ? (
            <QueryState status="pending" />
          ) : summaries.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void summaries.refetch();
              }}
            />
          ) : list.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('vulnerabilities.list.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>
                      {t('vulnerabilities.table.cve')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('vulnerabilities.table.severity')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('vulnerabilities.table.cvss')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('vulnerabilities.table.exposure')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('vulnerabilities.table.footprint')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((v) => (
                    <tr
                      key={v.cveId}
                      className={rowClass}
                      data-selected={v.cveId === selected ? 'true' : undefined}
                    >
                      <td className={tdClass}>
                        <button
                          type="button"
                          aria-pressed={v.cveId === selected}
                          aria-label={t('vulnerabilities.select', { cve: v.cveId })}
                          onClick={() => {
                            setSelected(v.cveId);
                          }}
                          className="text-start font-om-mono text-om-cyan hover:underline"
                        >
                          {v.cveId}
                        </button>
                        <span className="block text-om-2xs text-om-secondary">{v.title}</span>
                      </td>
                      <td className={tdClass}>
                        <StateBadge state={severityState(v.severity)} label={t(severityKey(v.severity))} />
                      </td>
                      <td className={tdClass + ' font-om-mono text-om-primary'}>{format.number(v.cvss)}</td>
                      <td className={tdClass}>
                        <span className="flex flex-wrap gap-om-4">
                          {v.exploited ? (
                            <Tag variant="state" state="down">
                              {t('vulnerabilities.flag.exploited')}
                            </Tag>
                          ) : null}
                          {v.cisaKev ? (
                            <Tag variant="state" state="degraded">
                              {t('vulnerabilities.flag.cisaKev')}
                            </Tag>
                          ) : null}
                          {v.internetFacing ? (
                            <Tag variant="state" state="at_risk">
                              {t('vulnerabilities.flag.internetFacing')}
                            </Tag>
                          ) : null}
                          <Tag>
                            {v.patchAvailable
                              ? t('vulnerabilities.flag.patchAvailable')
                              : t('vulnerabilities.flag.noPatch')}
                          </Tag>
                        </span>
                      </td>
                      <td className={tdClass + ' text-om-secondary'}>
                        {t('vulnerabilities.footprint', {
                          software: format.integer(v.affectedSoftware),
                          hosts: format.integer(v.affectedHosts),
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <section aria-label={t('vulnerabilities.detail.title')} className="flex flex-col">
          <Card padding="24" className="flex flex-col gap-om-16">
            <SectionTitle as="h2" size="sm" action={<Icon name="shield" className="size-5 text-om-rose" />}>
              {t('vulnerabilities.detail.title')}
            </SectionTitle>
            {selected === null ? (
              <p className="text-om-sm text-om-secondary">{t('vulnerabilities.detail.pick')}</p>
            ) : detail.isPending ? (
              <QueryState status="pending" />
            ) : detail.isError ? (
              <QueryState
                status="error"
                onRetry={() => {
                  void detail.refetch();
                }}
              />
            ) : detail.data === null ? (
              <QueryState status="empty" />
            ) : (
              <div className="flex flex-col gap-om-16">
                <div className="flex flex-col gap-om-6">
                  <div className="flex flex-wrap items-center gap-om-8">
                    <span className="font-om-mono text-om-sm text-om-primary">
                      {detail.data.summary.cveId}
                    </span>
                    <StateBadge
                      state={severityState(detail.data.summary.severity)}
                      label={t(severityKey(detail.data.summary.severity))}
                    />
                    <span className="font-om-mono text-om-xs text-om-secondary">
                      {format.number(detail.data.summary.cvss)}
                    </span>
                  </div>
                  <h3 className="font-om-display text-om-sm font-semibold text-om-primary">
                    {detail.data.summary.title}
                  </h3>
                  <dl className="grid grid-cols-2 gap-om-6 text-om-xs text-om-secondary">
                    <dt>{t('vulnerabilities.detail.published')}</dt>
                    <dd>
                      {detail.data.summary.publishedAt === null
                        ? t('common.none')
                        : format.dateTime(detail.data.summary.publishedAt)}
                    </dd>
                    <dt>{t('vulnerabilities.detail.fixedIn')}</dt>
                    <dd className="font-om-mono">
                      {detail.data.summary.fixedIn === null ? t('common.none') : detail.data.summary.fixedIn}
                    </dd>
                  </dl>
                </div>

                <section aria-label={t('vulnerabilities.detail.software')} className="flex flex-col gap-om-6">
                  <h4 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                    {t('vulnerabilities.detail.software') +
                      ' · ' +
                      format.integer(detail.data.software.length)}
                  </h4>
                  <ul className="flex flex-wrap gap-om-6 text-om-xs">
                    {detail.data.software.map((s) => (
                      <li key={s.id}>
                        <Link href={ciHref(s.id)} className="text-om-cyan hover:underline">
                          {s.displayName}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>

                <section aria-label={t('vulnerabilities.detail.hosts')} className="flex flex-col gap-om-6">
                  <h4 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                    {t('vulnerabilities.detail.hosts') + ' · ' + format.integer(detail.data.hosts.length)}
                  </h4>
                  {detail.data.hosts.length === 0 ? (
                    <p className="text-om-xs text-om-muted">{t('common.none')}</p>
                  ) : (
                    <ul className="flex flex-wrap gap-om-6 text-om-xs">
                      {detail.data.hosts.map((h) => (
                        <li key={h.id}>
                          <Link href={ciHref(h.id)} className="text-om-cyan hover:underline">
                            {h.displayName}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.data.blastRadiusTruncated ? (
                    <p className="text-om-2xs text-om-amber">
                      {t('vulnerabilities.detail.truncated', {
                        count: format.integer(VULNERABILITY.maxBlastRadiusHosts),
                      })}
                    </p>
                  ) : null}
                </section>

                <section aria-label={t('vulnerabilities.detail.services')} className="flex flex-col gap-om-6">
                  <h4 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                    {t('vulnerabilities.detail.services') +
                      ' · ' +
                      format.integer(detail.data.services.length)}
                  </h4>
                  {detail.data.services.length === 0 ? (
                    <p className="text-om-xs text-om-muted">{t('vulnerabilities.detail.noServices')}</p>
                  ) : (
                    <table className={tableClass}>
                      <thead className={theadClass}>
                        <tr>
                          <th scope="col" className={thClass}>
                            {t('vulnerabilities.detail.column.service')}
                          </th>
                          <th scope="col" className={thClass}>
                            {t('vulnerabilities.detail.column.predicted')}
                          </th>
                          <th scope="col" className={thClass}>
                            {t('vulnerabilities.detail.column.users')}
                          </th>
                          <th scope="col" className={thClass}>
                            {t('vulnerabilities.detail.column.sla')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.data.services.map((s) => (
                          <tr key={s.service.id} className={rowClass}>
                            <td className={tdClass}>
                              <Link href={ciHref(s.service.id)} className="text-om-cyan hover:underline">
                                {s.service.displayName}
                              </Link>
                              <span className="block text-om-2xs text-om-muted">
                                {t('vulnerabilities.detail.tier', { tier: format.integer(s.tier) })}
                              </span>
                            </td>
                            <td className={tdClass}>
                              <StateBadge
                                state={severityState(
                                  s.predicted === 'down'
                                    ? 'critical'
                                    : s.predicted === 'degraded'
                                      ? 'high'
                                      : s.predicted === 'at_risk'
                                        ? 'medium'
                                        : 'unknown',
                                )}
                                label={t(('impact.predicted.' + s.predicted) as MessageKey)}
                              />
                            </td>
                            <td className={tdClass + ' font-om-mono text-om-secondary'}>
                              {s.usersAffected === null ? t('common.none') : format.integer(s.usersAffected)}
                            </td>
                            <td className={tdClass + ' font-om-mono text-om-secondary'}>
                              {s.slaBudgetRemainingMinutes === null
                                ? t('common.none')
                                : t('vulnerabilities.detail.slaMinutes', {
                                    minutes: format.integer(s.slaBudgetRemainingMinutes),
                                  })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              </div>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}
