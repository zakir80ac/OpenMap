'use client';
// REQ-BSM-007 REQ-UI-012 (ADR-025) — Sites and connectivity: HA / DR readiness at a glance. The readiness rules with
// their open and recently cleared findings (each with its incident), every site with its DR role, criticality and
// healthy paths, and every inter-site link with its live probe figures (reachable, latency against the commitment,
// loss, when last probed) and health. Refreshes on the probe interval.
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { READINESS } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Card, Dot, SectionTitle, Tag } from '@openmap/ui';
import type { ReactNode } from 'react';
import { tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { healthKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { connectivityQuery, type CiSummary, type Connectivity, type ReadinessFinding } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';

export interface SitesViewProps {
  locale: Locale;
}

const RULES = ['diverse_paths', 'dr_reachable', 'replication_healthy'] as const;
const ruleKey = {
  diverse_paths: 'sites.rule.diverse_paths',
  dr_reachable: 'sites.rule.dr_reachable',
  replication_healthy: 'sites.rule.replication_healthy',
} as const satisfies Record<ReadinessFinding['rule'], string>;
const ruleHint = {
  diverse_paths: 'sites.rule.diverse_paths.hint',
  dr_reachable: 'sites.rule.dr_reachable.hint',
  replication_healthy: 'sites.rule.replication_healthy.hint',
} as const satisfies Record<ReadinessFinding['rule'], string>;
const LINK_ROLE_KEY = { primary: 'setup.links.role.primary', backup: 'setup.links.role.backup', overlay: 'setup.links.role.overlay' } as const;
const drRoleKey = {
  primary: 'sites.drRole.primary',
  dr: 'sites.drRole.dr',
  none: 'sites.drRole.none',
} as const;

function uiHealth(ci: CiSummary): 'healthy' | 'degraded' | 'down' | 'unknown' {
  const h = ci.health;
  return h === 'healthy' || h === 'degraded' || h === 'down' ? h : 'unknown';
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

export function SitesView({ locale }: SitesViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const query = useQuery(connectivityQuery(READINESS.evaluateMs));

  return (
    <div className="flex flex-col gap-om-16">
      <SectionTitle as="h1" size="lg" description={t('sites.description')}>
        {t('nav.sites')}
      </SectionTitle>
      {query.isPending ? (
        <QueryState status="pending" />
      ) : query.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : (
        <Body locale={locale} data={query.data} t={t} format={format} />
      )}
    </div>
  );
}

function Body({
  locale,
  data,
  t,
  format,
}: {
  locale: Locale;
  data: Connectivity;
  t: ReturnType<typeof useT>;
  format: ReturnType<typeof useFormatters>;
}): ReactNode {
  const open = data.findings.filter((f) => f.state === 'open');
  const healthyLinks = data.links.filter((l) => uiHealth(l.ci) === 'healthy').length;
  const ms = (value: number): string => t('sites.ms', { value: format.number(value) });

  return (
    <>
      <div className="grid grid-cols-2 gap-om-8 md:grid-cols-4" role="group" aria-label={t('sites.summary')}>
        {[
          [t('sites.summary.sites'), format.integer(data.sites.length)],
          [t('sites.summary.links'), format.integer(data.links.length)],
          [t('sites.summary.healthyLinks'), format.integer(healthyLinks)],
          [t('sites.summary.openFindings'), format.integer(open.length)],
        ].map(([label, value]) => (
          <Card key={label} padding="12" className="flex flex-col gap-om-2">
            <span className="text-om-2xs uppercase tracking-wide text-om-muted">{label}</span>
            <span className="text-om-lg font-semibold text-om-primary">{value}</span>
          </Card>
        ))}
      </div>

      <section aria-label={t('sites.readiness')}>
        <Card className="flex flex-col gap-om-10">
          <SectionTitle
            as="h2"
            size="sm"
            description={
              data.probeIntervalSeconds === 0
                ? t('sites.probingOff')
                : t('sites.probing', { seconds: format.integer(data.probeIntervalSeconds) })
            }
          >
            {t('sites.readiness')}
          </SectionTitle>
          <ul className="flex flex-col gap-om-8">
            {RULES.map((rule) => {
              const findings = data.findings.filter((f) => f.rule === rule);
              const breached = findings.filter((f) => f.state === 'open');
              return (
                <li
                  key={rule}
                  className="flex flex-col gap-om-4 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8"
                >
                  <div className="flex flex-wrap items-center gap-om-8">
                    <Dot state={breached.length > 0 ? 'down' : 'healthy'} />
                    <span className="min-w-0 flex-1 text-om-sm font-medium text-om-primary">
                      {t(ruleKey[rule])}
                    </span>
                    <Tag variant="state" state={breached.length > 0 ? 'down' : 'healthy'}>
                      {breached.length > 0
                        ? t('sites.breached', { count: format.integer(breached.length) })
                        : t('sites.passing')}
                    </Tag>
                  </div>
                  <p className="text-om-2xs text-om-muted">{t(ruleHint[rule])}</p>
                  {findings.length > 0 ? (
                    <ul className="flex flex-col gap-om-2 text-om-xs" aria-label={t(ruleKey[rule])}>
                      {findings.map((f) => (
                        <li key={f.id} className="flex flex-wrap items-center gap-om-6">
                          <Tag variant="state" state={f.state === 'open' ? 'down' : 'healthy'}>
                            {f.state === 'open' ? t('sites.finding.open') : t('sites.finding.cleared')}
                          </Tag>
                          {f.subject !== null ? <CiLink locale={locale} ci={f.subject} /> : null}
                          <span className="text-om-2xs text-om-muted">
                            {f.state === 'open'
                              ? t('sites.finding.since', { when: format.dateTime(f.openedAt) })
                              : t('sites.finding.clearedAt', {
                                  when: format.dateTime(f.clearedAt ?? f.openedAt),
                                })}
                          </span>
                          {f.incident !== null ? (
                            <span className="text-om-2xs text-om-secondary">
                              {t('sites.finding.incident', { title: f.incident.title })}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      <section aria-label={t('sites.sites')}>
        <Card className="flex flex-col gap-om-10">
          <SectionTitle as="h2" size="sm">
            {t('sites.sites')}
          </SectionTitle>
          {data.sites.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('sites.noSites')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass} aria-label={t('sites.sites')}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>
                      {t('sites.table.site')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.drRole')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.criticality')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.paths')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.health')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.sites.map((s) => (
                    <tr key={s.ci.id}>
                      <td className={tdClass}>
                        <CiLink locale={locale} ci={s.ci} />
                        <span className="block font-om-mono text-om-2xs text-om-muted">{s.code}</span>
                      </td>
                      <td className={tdClass}>{t(drRoleKey[s.drRole])}</td>
                      <td className={tdClass}>
                        {s.criticality === null ? t('sites.none') : format.integer(s.criticality)}
                      </td>
                      <td className={tdClass}>{format.integer(s.healthyPaths)}</td>
                      <td className={tdClass}>
                        <Tag variant="state" state={uiHealth(s.ci)}>
                          {t(healthKey[uiHealth(s.ci)])}
                        </Tag>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>

      <section aria-label={t('sites.links')}>
        <Card className="flex flex-col gap-om-10">
          <SectionTitle as="h2" size="sm">
            {t('sites.links')}
          </SectionTitle>
          {data.links.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('sites.noLinks')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass} aria-label={t('sites.links')}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>
                      {t('sites.table.link')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.ends')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.reachable')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.latency')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.loss')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.probed')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.health')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.links.map((l) => (
                    <tr key={l.ci.id}>
                      <td className={tdClass}>
                        <CiLink locale={locale} ci={l.ci} />
                        <span className="mt-om-2 flex flex-wrap gap-om-4">
                          {l.replication ? <Tag>{t('sites.replication')}</Tag> : null}
                          {l.role !== null ? <Tag>{l.role in LINK_ROLE_KEY ? t(LINK_ROLE_KEY[l.role as keyof typeof LINK_ROLE_KEY]) : l.role}</Tag> : null}
                        </span>
                      </td>
                      <td className={tdClass}>
                        <span className="font-om-mono">
                          {t('sites.ends', { from: l.fromSite ?? '?', to: l.toSite ?? '?' })}
                        </span>
                        <span className="block text-om-2xs text-om-muted">
                          {l.probeTarget ?? t('sites.notProbed')}
                        </span>
                      </td>
                      <td className={tdClass}>
                        {l.reachable === null
                          ? t('sites.none')
                          : l.reachable
                            ? t('sites.yes')
                            : t('sites.no')}
                      </td>
                      <td className={tdClass}>
                        {l.latencyMs === null ? t('sites.none') : ms(l.latencyMs)}
                        {l.slaLatencyMs !== null ? (
                          <span className="block text-om-2xs text-om-muted">
                            {t('sites.committed', { value: ms(l.slaLatencyMs) })}
                          </span>
                        ) : null}
                      </td>
                      <td className={tdClass}>
                        {l.lossPercent === null
                          ? t('sites.none')
                          : t('sites.percent', { value: format.number(l.lossPercent) })}
                      </td>
                      <td className={tdClass}>
                        {l.probedAt === null ? t('sites.none') : format.dateTime(l.probedAt)}
                      </td>
                      <td className={tdClass}>
                        <Tag variant="state" state={uiHealth(l.ci)}>
                          {t(healthKey[uiHealth(l.ci)])}
                        </Tag>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </>
  );
}
