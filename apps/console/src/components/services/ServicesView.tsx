'use client';
// REQ-UI-012 REQ-BSM-002 — Business services: every service from `services` with propagated state, since, root
// causes, SLA target and error budget, grouped by state (worst first) with a health filter; open incidents from
// `incidents` beside them with an acknowledge action (acknowledgeIncident).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES } from '@openmap/constants';
import { useCan } from '@/lib/auth';
import Link from 'next/link';
import { BSM, CONSOLE } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Bar, Card, Dot, Kpi, Pill, SectionTitle, StateBadge, Tag, accents, cx, stateColor } from '@openmap/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { healthKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { acknowledgeIncident, incidentsQuery, servicesQuery, type CiRef, type HealthState, type Incident, type ServiceHealth } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';

export interface ServicesViewProps {
  locale: Locale;
}

/** Display order: worst first, from the shared BSM severity order. */
export const SERVICE_GROUP_ORDER: readonly HealthState[] = [...BSM.healthOrder].reverse();

const groupKey = {
  down: 'services.group.down',
  degraded: 'services.group.degraded',
  unknown: 'services.group.unknown',
  healthy: 'services.group.healthy',
} as const satisfies Record<HealthState, string>;

/** Services grouped by state in SERVICE_GROUP_ORDER; within a group the least error budget comes first. */
export function groupServices(services: ReadonlyArray<ServiceHealth>, filter: HealthState | undefined): Array<{ state: HealthState; items: ServiceHealth[] }> {
  return SERVICE_GROUP_ORDER.filter((state) => filter === undefined || filter === state)
    .map((state) => ({
      state,
      items: services.filter((s) => s.state === state).sort((a, b) => a.errorBudgetRemainingMinutes - b.errorBudgetRemainingMinutes || a.service.displayName.localeCompare(b.service.displayName)),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * Share of the SLA period's error budget still unspent, 0..100. The budget is the downtime an SLA target allows over
 * BSM.slaPeriodDays (99.95% over 30 days ≈ 21.6 minutes); an exhausted or undefined budget reads as 0.
 */
export function errorBudgetPercent(slaTargetPercent: number, remainingMinutes: number): number {
  const totalMinutes = (1 - slaTargetPercent / BSM.percentScale) * BSM.slaPeriodDays * BSM.minutesPerDay;
  if (totalMinutes <= 0 || remainingMinutes <= 0) return 0;
  return Math.min(BSM.percentScale, (remainingMinutes / totalMinutes) * BSM.percentScale);
}

function ciHref(locale: Locale, ci: Pick<CiRef, 'id'>): string {
  return localizedHref(locale, '/cmdb/' + encodeURIComponent(ci.id));
}

function mapHref(locale: Locale, ci: Pick<CiRef, 'id'>): string {
  return localizedHref(locale, '/dependencies') + '?' + new URLSearchParams({ ci: ci.id, direction: 'downstream' }).toString();
}

export function ServicesView({ locale }: ServicesViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<HealthState | undefined>(undefined);
  const services = useQuery({ ...servicesQuery(), refetchInterval: CONSOLE.livePollMs });
  const incidents = useQuery({ ...incidentsQuery(true), refetchInterval: CONSOLE.livePollMs });

  const groups = useMemo(() => groupServices(services.data ?? [], filter), [services.data, filter]);
  const incidentsByService = useMemo(() => {
    const map = new Map<string, Incident[]>();
    for (const incident of incidents.data ?? []) {
      const list = map.get(incident.service.id) ?? [];
      list.push(incident);
      map.set(incident.service.id, list);
    }
    return map;
  }, [incidents.data]);

  const can = useCan();
  const allowed = can(ROLES.operator);
  const acknowledge = useMutation({
    mutationFn: acknowledgeIncident,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['incidents'] });
      await queryClient.invalidateQueries({ queryKey: ['services'] });
    },
  });

  const counts = useMemo(() => {
    const list = services.data ?? [];
    return {
      total: list.length,
      down: list.filter((s) => s.state === 'down').length,
      degraded: list.filter((s) => s.state === 'degraded').length,
      incidents: incidents.data?.length ?? 0,
    };
  }, [services.data, incidents.data]);

  return (
    <div className="flex flex-col gap-om-20">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('services.subtitle')}>
        {t('nav.services')}
      </SectionTitle>

      <section className="grid grid-cols-2 gap-om-12 xl:grid-cols-4" aria-busy={services.isPending}>
        <Card padding="16">
          <Kpi label={t('services.kpi.total')} value={services.isSuccess ? format.integer(counts.total) : '…'} />
        </Card>
        <Card padding="16">
          <Kpi label={t('services.kpi.down')} value={services.isSuccess ? format.integer(counts.down) : '…'} {...(counts.down > 0 ? { accent: accents.rose } : {})} />
        </Card>
        <Card padding="16">
          <Kpi label={t('services.kpi.degraded')} value={services.isSuccess ? format.integer(counts.degraded) : '…'} {...(counts.degraded > 0 ? { accent: accents.amber } : {})} />
        </Card>
        <Card padding="16">
          <Kpi label={t('services.kpi.incidents')} value={incidents.isSuccess ? format.integer(counts.incidents) : '…'} accent={accents.violet} />
        </Card>
      </section>

      <div className="grid grid-cols-1 gap-om-16 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-om-12">
          <div role="group" aria-label={t('services.filter')} className="flex flex-wrap gap-om-6">
            <Pill
              variant={filter === undefined ? 'primary' : 'default'}
              selected={filter === undefined}
              glowing={false}
              onClick={() => {
                setFilter(undefined);
              }}
            >
              {t('services.filter.all')}
            </Pill>
            {SERVICE_GROUP_ORDER.map((state) => (
              <Pill
                key={state}
                variant={filter === state ? 'primary' : 'default'}
                selected={filter === state}
                glowing={false}
                icon={<Dot state={state} />}
                onClick={() => {
                  setFilter(filter === state ? undefined : state);
                }}
              >
                {t(healthKey[state])}
              </Pill>
            ))}
          </div>

          {services.isPending ? (
            <Card>
              <QueryState status="pending" />
            </Card>
          ) : services.isError ? (
            <Card>
              <QueryState
                status="error"
                onRetry={() => {
                  void services.refetch();
                }}
              />
            </Card>
          ) : groups.length === 0 ? (
            <Card>
              <QueryState status="empty" />
              <p className="mt-om-8 text-om-sm text-om-secondary">{t('services.empty')}</p>
            </Card>
          ) : (
            groups.map((group) => (
              <Card key={group.state} as="section" className="flex flex-col gap-om-10" style={{ borderColor: group.state === 'healthy' ? undefined : stateColor(group.state) + '55' }}>
                <SectionTitle as="h2" size="sm" action={<Tag>{t('services.groupCount', { count: format.integer(group.items.length) })}</Tag>}>
                  <span className="flex items-center gap-om-8">
                    <Dot state={group.state} pulse={group.state === 'down'} />
                    {t(groupKey[group.state])}
                  </span>
                </SectionTitle>
                <ul className="flex flex-col gap-om-8">
                  {group.items.map((item) => {
                    const budgetPercent = errorBudgetPercent(item.slaTarget, item.errorBudgetRemainingMinutes);
                    const exhausted = item.errorBudgetRemainingMinutes <= 0;
                    const open = incidentsByService.get(item.service.id) ?? [];
                    return (
                      <li key={item.service.id} className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-12">
                        <div className="flex flex-wrap items-center gap-om-10">
                          <StateBadge state={item.state} label={t(healthKey[item.state])} live={item.state !== 'healthy'} />
                          <Link href={ciHref(locale, item.service)} className="min-w-0 flex-1 truncate font-om-display text-om-md font-bold text-om-primary hover:text-om-cyan">
                            {item.service.displayName}
                          </Link>
                          <span className="text-om-2xs text-om-muted">{t('services.since', { when: format.dateTime(item.since) })}</span>
                          <Tag>{t('services.slaTarget', { target: format.number(item.slaTarget) })}</Tag>
                          {open.length > 0 ? (
                            <Tag variant="state" state="down">
                              {t('services.openIncident')}
                            </Tag>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-om-10">
                          <Bar value={budgetPercent} max={BSM.percentScale} accent={exhausted ? accents.rose : item.state === 'healthy' ? accents.emerald : accents.amber} label={t('services.errorBudget', { minutes: format.integer(item.errorBudgetRemainingMinutes) })} className="flex-1" />
                          <span className={cx('whitespace-nowrap font-om-mono text-om-2xs', exhausted ? 'text-om-rose' : 'text-om-secondary')}>
                            {exhausted
                              ? t('services.errorBudgetExhausted', { minutes: format.integer(Math.abs(item.errorBudgetRemainingMinutes)) })
                              : t('services.errorBudget', { minutes: format.integer(item.errorBudgetRemainingMinutes) })}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-om-6 text-om-xs">
                          <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('services.rootCauses')}</span>
                          {item.rootCauses.length === 0 ? (
                            <span className="text-om-secondary">{t('services.noRootCause')}</span>
                          ) : (
                            item.rootCauses.map((cause) => (
                              <Link key={cause.id} href={ciHref(locale, cause)} className="rounded-om-tag border border-om-rose/30 bg-om-rose/10 px-om-8 py-om-4 text-om-rose hover:bg-om-rose/20">
                                {cause.displayName}
                              </Link>
                            ))
                          )}
                          <Link href={mapHref(locale, item.service)} className="ms-auto flex items-center gap-om-4 text-om-cyan hover:underline">
                            <Icon name="dependencies" className="size-3.5" />
                            {t('services.showInMap')}
                          </Link>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ))
          )}
        </div>

        <Card as="aside" className="flex flex-col gap-om-12 self-start">
          <SectionTitle as="h2" size="sm" description={t('services.incidents.subtitle')}>
            {t('services.incidents.title')}
          </SectionTitle>
          {incidents.isPending ? (
            <QueryState status="pending" />
          ) : incidents.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void incidents.refetch();
              }}
            />
          ) : incidents.data.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('services.incidents.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-om-8">
              {incidents.data.map((incident) => {
                const acknowledging = acknowledge.isPending && acknowledge.variables === incident.id;
                const acknowledged = acknowledge.isSuccess && acknowledge.data.id === incident.id;
                return (
                  <li key={incident.id} className="flex flex-col gap-om-6 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-10">
                    <div className="flex items-center gap-om-8">
                      <Dot state={incident.resolvedAt === null ? 'down' : 'healthy'} pulse={incident.resolvedAt === null} />
                      <Link href={ciHref(locale, incident.service)} className="min-w-0 flex-1 truncate text-om-sm font-medium text-om-primary hover:text-om-cyan">
                        {incident.service.displayName}
                      </Link>
                      <Tag>{t('services.incidents.alerts', { count: format.integer(incident.alerts) })}</Tag>
                    </div>
                    <p className="text-om-2xs text-om-muted">
                      {t('services.incidents.opened', { when: format.dateTime(incident.openedAt) })}
                      {incident.resolvedAt !== null ? ' · ' + t('services.incidents.resolved', { when: format.dateTime(incident.resolvedAt) }) : ''}
                    </p>
                    {incident.rootCause !== null ? (
                      <Link href={ciHref(locale, incident.rootCause)} className="text-om-xs text-om-rose hover:underline">
                        {t('services.incidents.rootCause', { name: incident.rootCause.displayName })}
                      </Link>
                    ) : null}
                    {incident.links.length > 0 ? (
                      <ul className="flex flex-wrap gap-om-4">
                        {incident.links.map((link) => (
                          <li key={link.integration.id + link.remoteId}>
                            <Tag>{t('services.incidents.link', { vendor: link.integration.vendor, remoteId: link.remoteId, state: link.remoteState })}</Tag>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="flex items-center gap-om-8">
                      <button
                        type="button"
                        disabled={acknowledging || acknowledged || !allowed}
                        title={allowed ? undefined : t('auth.requiresRole', { role: ROLES.operator })}
                        onClick={() => {
                          acknowledge.mutate(incident.id);
                        }}
                        className="flex items-center gap-om-6 rounded-om-control-lg border border-om-cyan/30 bg-om-cyan/10 px-om-10 py-om-6 text-om-xs font-medium text-om-cyan transition-colors duration-om-base hover:bg-om-cyan/20 disabled:opacity-60"
                      >
                        <Icon name="check" className="size-3.5" />
                        {acknowledging ? t('services.incidents.acknowledging') : acknowledged ? t('services.incidents.acknowledged') : t('services.incidents.acknowledge')}
                      </button>
                      {acknowledge.isError && acknowledge.variables === incident.id ? (
                        <span role="alert" className="text-om-xs text-om-rose">
                          {t('services.incidents.ackError')}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
