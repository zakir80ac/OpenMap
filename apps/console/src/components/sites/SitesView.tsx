'use client';
// REQ-BSM-007 REQ-UI-012 (ADR-025) — Sites and connectivity: HA / DR readiness at a glance. The readiness rules with
// their open and recently cleared findings (each with its incident), every site with its DR role, criticality and
// healthy paths, and every inter-site link with its live probe figures (reachable, latency against the commitment,
// loss, when last probed) and health. Refreshes on the probe interval.
// REQ-UI-026: each site as a facility card (kind, tier, power capacity, racks, PUE measured and design, open alerts),
// and each link with its carrier, traffic against the committed bandwidth and the redundancy state between its sites.
// REQ-IPAM-007 (ADR-069): each link's circuit register (carrier contract, physical route, the carrier circuits it rides
// on with their health), the risks it shares with other links between the same sites, the path_diversity and
// redundancy_lost rules, and, for operators, the register's edit of a link.
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { IPAM, READINESS, ROLES } from '@openmap/constants';
import { READINESS_RULES, type LinkRedundancy, type LinkSharedRiskKind } from '@openmap/contracts';
import type { Locale } from '@openmap/i18n';
import { Bar, Card, Dot, SectionTitle, Tag, accents, type HexColor } from '@openmap/ui';
import { useState, type ReactNode } from 'react';
import { Button, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { useCan } from '@/lib/auth';
import { healthKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { connectivityQuery, type CiSummary, type Connectivity, type ReadinessFinding } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';
import { LinkCircuitForm } from './LinkCircuitForm';

export interface SitesViewProps {
  locale: Locale;
}

const RULES = READINESS_RULES;
const ruleKey = {
  diverse_paths: 'sites.rule.diverse_paths',
  dr_reachable: 'sites.rule.dr_reachable',
  replication_healthy: 'sites.rule.replication_healthy',
  path_diversity: 'sites.rule.path_diversity',
  redundancy_lost: 'sites.rule.redundancy_lost',
} as const satisfies Record<ReadinessFinding['rule'], string>;
const ruleHint = {
  diverse_paths: 'sites.rule.diverse_paths.hint',
  dr_reachable: 'sites.rule.dr_reachable.hint',
  replication_healthy: 'sites.rule.replication_healthy.hint',
  path_diversity: 'sites.rule.path_diversity.hint',
  redundancy_lost: 'sites.rule.redundancy_lost.hint',
} as const satisfies Record<ReadinessFinding['rule'], string>;
const sharedRiskKey = {
  provider: 'sites.circuit.shares.provider',
  path: 'sites.circuit.shares.path',
  circuit: 'sites.circuit.shares.circuit',
} as const satisfies Record<LinkSharedRiskKind, string>;
const LINK_ROLE_KEY = { primary: 'setup.links.role.primary', backup: 'setup.links.role.backup', overlay: 'setup.links.role.overlay' } as const;
const SITE_KIND_KEY = {
  datacenter: 'setup.sites.kind.datacenter',
  colocation: 'setup.sites.kind.colocation',
  office: 'setup.sites.kind.office',
  branch: 'setup.sites.kind.branch',
  cloud_region: 'setup.sites.kind.cloud_region',
  edge: 'setup.sites.kind.edge',
} as const;
const redundancyKey = {
  active_active: 'sites.redundancy.active_active',
  active_standby: 'sites.redundancy.active_standby',
  degraded: 'sites.redundancy.degraded',
  down: 'sites.redundancy.down',
  single_path: 'sites.redundancy.single_path',
} as const satisfies Record<LinkRedundancy, string>;
const redundancyState = {
  active_active: 'healthy',
  active_standby: 'healthy',
  degraded: 'degraded',
  down: 'down',
  single_path: 'unknown',
} as const satisfies Record<LinkRedundancy, 'healthy' | 'degraded' | 'down' | 'unknown'>;

/** The same thresholds as subnet utilisation: amber from the warning share, rose from the critical one. */
function trafficAccent(percent: number): HexColor {
  if (percent >= IPAM.criticalUtilisationPercent) return accents.rose;
  if (percent >= IPAM.warnUtilisationPercent) return accents.amber;
  return accents.cyan;
}
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
  const can = useCan();
  const operator = can(ROLES.operator);
  const [editing, setEditing] = useState<string | null>(null);
  const editLink = editing === null ? undefined : data.links.find((l) => l.ci.id === editing);
  const open = data.findings.filter((f) => f.state === 'open');
  const healthyLinks = data.links.filter((l) => uiHealth(l.ci) === 'healthy').length;
  const ms = (value: number): string => t('sites.ms', { value: format.number(value) });
  // Gigabits once a rate reaches one: 10,000 Mb/s reads 10 Gb/s.
  const rate = (mbps: number): string =>
    mbps >= READINESS.megabitsPerGigabit
      ? t('sites.gbps', { value: format.number(mbps / READINESS.megabitsPerGigabit) })
      : t('sites.mbps', { value: format.number(mbps) });

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
            {t('sites.facility')}
          </SectionTitle>
          {data.sites.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('sites.noSites')}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-om-8 md:grid-cols-2 xl:grid-cols-3" aria-label={t('sites.sites')}>
              {data.sites.map((s) => (
                <li
                  key={s.ci.id}
                  aria-label={s.ci.displayName}
                  className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8"
                >
                  <div className="flex flex-wrap items-start gap-om-6">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-om-sm font-medium text-om-primary">
                        <CiLink locale={locale} ci={s.ci} />
                      </h3>
                      <span className="font-om-mono text-om-2xs text-om-muted">{s.code}</span>
                    </div>
                    <Tag variant="state" state={uiHealth(s.ci)}>
                      {t(healthKey[uiHealth(s.ci)])}
                    </Tag>
                  </div>
                  <div className="flex flex-wrap gap-om-4">
                    {s.kind !== null ? (
                      <Tag>{s.kind in SITE_KIND_KEY ? t(SITE_KIND_KEY[s.kind as keyof typeof SITE_KIND_KEY]) : s.kind}</Tag>
                    ) : null}
                    <Tag>
                      {s.tier === null ? t('sites.card.noTier') : t('sites.card.tier', { tier: format.integer(s.tier) })}
                    </Tag>
                    <Tag>{t(drRoleKey[s.drRole])}</Tag>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-om-8 gap-y-om-4 text-om-xs">
                    <div>
                      <dt className="text-om-2xs text-om-muted">{t('sites.card.power')}</dt>
                      <dd className="text-om-primary">
                        {s.powerCapacityKw === null
                          ? t('sites.none')
                          : t('sites.card.kw', { value: format.number(s.powerCapacityKw) })}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-om-2xs text-om-muted">{t('sites.card.racks')}</dt>
                      <dd className="text-om-primary">{format.integer(s.racks)}</dd>
                    </div>
                    <div>
                      <dt className="text-om-2xs text-om-muted">{t('sites.card.pue')}</dt>
                      <dd className="text-om-primary">
                        {s.pue !== null
                          ? format.number(s.pue)
                          : s.designPue !== null
                            ? t('sites.card.pueDesign', { value: format.number(s.designPue) })
                            : t('sites.none')}
                        {s.pue !== null && s.pueAt !== null ? (
                          <span className="block text-om-2xs text-om-muted">
                            {t('sites.card.pueMeasured', { when: format.dateTime(s.pueAt) })}
                          </span>
                        ) : null}
                        {s.pue !== null && s.designPue !== null ? (
                          <span className="block text-om-2xs text-om-muted">
                            {t('sites.card.pueDesign', { value: format.number(s.designPue) })}
                          </span>
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-om-2xs text-om-muted">{t('sites.card.alerts')}</dt>
                      <dd>
                        <Tag variant="state" state={s.openAlerts > 0 ? 'down' : 'healthy'}>
                          {format.integer(s.openAlerts)}
                        </Tag>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-om-2xs text-om-muted">{t('sites.card.criticality')}</dt>
                      <dd className="text-om-primary">
                        {s.criticality === null ? t('sites.none') : format.integer(s.criticality)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-om-2xs text-om-muted">{t('sites.card.paths')}</dt>
                      <dd className="text-om-primary">{format.integer(s.healthyPaths)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
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
                      {t('sites.table.carrier')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.throughput')}
                    </th>
                    <th scope="col" className={thClass}>
                      {t('sites.table.redundancy')}
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
                        {operator ? (
                          <Button
                            tone="quiet"
                            className="mt-om-4"
                            aria-label={t('sites.circuit.edit', { link: l.ci.displayName })}
                            onClick={() => { setEditing(l.ci.id); }}
                          >
                            {t('sites.circuit.editShort')}
                          </Button>
                        ) : null}
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
                        <span className="flex flex-col gap-om-2">
                          <span>{l.provider ?? t('sites.none')}</span>
                          {l.carrierContractRef !== null ? (
                            <span className="text-om-2xs text-om-muted">{t('sites.circuit.contract', { ref: l.carrierContractRef })}</span>
                          ) : null}
                          {l.pathRef !== null ? (
                            <span className="text-om-2xs text-om-muted">{t('sites.circuit.route', { ref: l.pathRef })}</span>
                          ) : null}
                          {l.circuits.length > 0 ? (
                            <span className="flex flex-wrap gap-om-4" aria-label={t('sites.circuit.carriers')}>
                              {l.circuits.map((c) => (
                                <Tag key={c.ci.id} variant="state" state={uiHealth(c.ci)}>
                                  {c.ci.displayName}
                                </Tag>
                              ))}
                            </span>
                          ) : null}
                          {l.sharedRisks.map((r) => (
                            <span key={r.kind + r.value + (r.other?.id ?? '')} className="text-om-2xs text-om-state-degraded">
                              {t(sharedRiskKey[r.kind], { value: r.value, link: r.other?.displayName ?? t('sites.none') })}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className={tdClass}>
                        {l.throughputMbps === null ? (
                          l.capacityMbps === null ? (
                            t('sites.none')
                          ) : (
                            <span className="text-om-muted">{rate(l.capacityMbps)}</span>
                          )
                        ) : (
                          <span className="flex flex-col gap-om-2">
                            <span>
                              {l.capacityMbps === null
                                ? rate(l.throughputMbps)
                                : t('sites.throughput', { value: rate(l.throughputMbps), capacity: rate(l.capacityMbps) })}
                            </span>
                            {l.utilisationPercent !== null ? (
                              <>
                                <Bar
                                  value={l.utilisationPercent}
                                  accent={trafficAccent(l.utilisationPercent)}
                                  label={t('sites.table.throughput') + ' ' + l.ci.displayName}
                                />
                                <span className="text-om-2xs text-om-muted">
                                  {t('sites.utilisation', { value: format.number(l.utilisationPercent) })}
                                </span>
                              </>
                            ) : null}
                          </span>
                        )}
                      </td>
                      <td className={tdClass}>
                        <Tag variant="state" state={redundancyState[l.redundancy]}>
                          {t(redundancyKey[l.redundancy])}
                        </Tag>
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
      {operator && editLink !== undefined ? (
        <section aria-label={t('sites.circuit.title', { link: editLink.ci.displayName })}>
          <LinkCircuitForm key={editLink.ci.id} link={editLink} onDone={() => { setEditing(null); }} />
        </section>
      ) : null}
    </>
  );
}
