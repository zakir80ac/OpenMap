'use client';
// REQ-UI-012 REQ-BSM-002 REQ-BSM-006 REQ-BSM-008 — Business services: every service from `services` with propagated
// state, since, root causes, the SLA it is held to and its current window (availability, error budget, burn rate),
// grouped by state (worst first) with a health filter; the uptime table by month, quarter or year with CSV export; the
// SLA catalogue; and the incidents beside them with acknowledge, assign, resolve, close and RCA (ADR-024).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { BSM, CONSOLE, ROLES, SLA, type AvailabilityGranularity, type SlaWindow } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import type { MessageKey } from '@openmap/i18n';
import {
  Bar,
  Card,
  Dot,
  Kpi,
  Pill,
  SectionTitle,
  StateBadge,
  Tag,
  accents,
  cx,
  stateColor,
} from '@openmap/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { Button, Select } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { Icon } from '@/components/icons';
import { useCan } from '@/lib/auth';
import { healthKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import {
  acknowledgeIncident,
  assignIncident,
  assignSla,
  availabilityReportCsv,
  availabilityReportQuery,
  closeIncident,
  deleteSla,
  incidentsQuery,
  resolveIncident,
  servicesQuery,
  slasQuery,
  updateIncidentRca,
  upsertSla,
  type CiRef,
  type HealthState,
  type Incident,
  type RcaInput,
  type ServiceHealth,
  type SlaInput,
} from '@/lib/queries';
import { useFormatters, useT } from '@/providers';
import { IncidentCard, type IncidentActions } from './IncidentCard';
import { SlaPanel } from './SlaPanel';
import { UptimeTable, availabilityTone } from './UptimeTable';

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

const CSV_TYPE = 'text/csv;charset=utf-8';
const CSV_NAME_PREFIX = 'openmap-availability-';
const CSV_EXTENSION = '.csv';

/** The label of a service's measuring window: the SLA's window, or the rolling 30 days without one. */
export function windowLabelKey(window: SlaWindow | null): MessageKey {
  switch (window) {
    case 'calendar_month':
      return 'services.window.calendar_month';
    case 'calendar_quarter':
      return 'services.window.calendar_quarter';
    case 'calendar_year':
      return 'services.window.calendar_year';
    default:
      return 'services.window.rolling_30d';
  }
}

/** Offers a CSV text as a file download in the browser. */
export function downloadCsv(csv: string, granularity: AvailabilityGranularity): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([csv], { type: CSV_TYPE }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = CSV_NAME_PREFIX + granularity + CSV_EXTENSION;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Services grouped by state in SERVICE_GROUP_ORDER; within a group the least error budget comes first. */
export function groupServices(
  services: ReadonlyArray<ServiceHealth>,
  filter: HealthState | undefined,
): Array<{ state: HealthState; items: ServiceHealth[] }> {
  return SERVICE_GROUP_ORDER.filter((state) => filter === undefined || filter === state)
    .map((state) => ({
      state,
      items: services
        .filter((s) => s.state === state)
        .sort(
          (a, b) =>
            a.errorBudgetRemainingMinutes - b.errorBudgetRemainingMinutes ||
            a.service.displayName.localeCompare(b.service.displayName),
        ),
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

function serviceHref(locale: Locale, ci: Pick<CiRef, 'id'>): string {
  return localizedHref(locale, '/services/' + encodeURIComponent(ci.id));
}

function mapHref(locale: Locale, ci: Pick<CiRef, 'id'>): string {
  return (
    localizedHref(locale, '/dependencies') +
    '?' +
    new URLSearchParams({ ci: ci.id, direction: 'downstream' }).toString()
  );
}

export function ServicesView({ locale }: ServicesViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<HealthState | undefined>(undefined);
  const [granularity, setGranularity] = useState<AvailabilityGranularity>('month');
  const [showResolved, setShowResolved] = useState(false);
  const services = useQuery({ ...servicesQuery(), refetchInterval: CONSOLE.livePollMs });
  const incidents = useQuery({ ...incidentsQuery(!showResolved), refetchInterval: CONSOLE.livePollMs });
  const slas = useQuery(slasQuery());
  const report = useQuery(availabilityReportQuery(granularity, SLA.defaultPeriods[granularity]));

  const groups = useMemo(() => groupServices(services.data ?? [], filter), [services.data, filter]);
  const incidentsByService = useMemo(() => {
    const map = new Map<string, Incident[]>();
    for (const incident of incidents.data ?? []) {
      if (incident.state === 'resolved' || incident.state === 'closed') continue;
      const list = map.get(incident.service.id) ?? [];
      list.push(incident);
      map.set(incident.service.id, list);
    }
    return map;
  }, [incidents.data]);

  const can = useCan();
  const canOperate = can(ROLES.operator);
  const invalidate = async (...keys: string[]): Promise<void> => {
    for (const key of keys) await queryClient.invalidateQueries({ queryKey: [key] });
  };
  const exportCsv = useMutation({
    mutationFn: () =>
      availabilityReportCsv(granularity, SLA.defaultPeriods[granularity]).then((csv) => {
        downloadCsv(csv, granularity);
      }),
  });
  const assignment = useMutation({
    mutationFn: ({ serviceId, slaId }: { serviceId: string; slaId: string | null }) =>
      assignSla(serviceId, slaId),
    onSuccess: () => invalidate('services', 'slas', 'availabilityReport'),
  });
  const actions: IncidentActions = {
    acknowledge: (id) => acknowledgeIncident(id).then(() => invalidate('incidents', 'services')),
    assign: (id, assignee) => assignIncident(id, assignee).then(() => invalidate('incidents')),
    resolve: (id, note) => resolveIncident(id, note).then(() => invalidate('incidents', 'services')),
    close: (id) => closeIncident(id).then(() => invalidate('incidents')),
    saveRca: (id, input: RcaInput) => updateIncidentRca(id, input).then(() => invalidate('incidents')),
  };
  const saveSla = (id: string | null, input: SlaInput): Promise<unknown> =>
    upsertSla(id, input).then(() => invalidate('slas', 'services'));
  const removeSla = (id: string): Promise<unknown> =>
    deleteSla(id).then(() => invalidate('slas', 'services', 'availabilityReport'));

  const counts = useMemo(() => {
    const list = services.data ?? [];
    return {
      total: list.length,
      down: list.filter((s) => s.state === 'down').length,
      degraded: list.filter((s) => s.state === 'degraded').length,
      incidents: (incidents.data ?? []).filter((i) => i.state !== 'resolved' && i.state !== 'closed').length,
    };
  }, [services.data, incidents.data]);

  return (
    <div className="flex flex-col gap-om-20">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('services.subtitle')}>
        {t('nav.services')}
      </SectionTitle>

      <section className="grid grid-cols-2 gap-om-12 xl:grid-cols-4" aria-busy={services.isPending}>
        <Card padding="16">
          <Kpi
            label={t('services.kpi.total')}
            value={services.isSuccess ? format.integer(counts.total) : '…'}
          />
        </Card>
        <Card padding="16">
          <Kpi
            label={t('services.kpi.down')}
            value={services.isSuccess ? format.integer(counts.down) : '…'}
            {...(counts.down > 0 ? { accent: accents.rose } : {})}
          />
        </Card>
        <Card padding="16">
          <Kpi
            label={t('services.kpi.degraded')}
            value={services.isSuccess ? format.integer(counts.degraded) : '…'}
            {...(counts.degraded > 0 ? { accent: accents.amber } : {})}
          />
        </Card>
        <Card padding="16">
          <Kpi
            label={t('services.kpi.incidents')}
            value={incidents.isSuccess ? format.integer(counts.incidents) : '…'}
            accent={accents.violet}
          />
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

          {/* A fixed-height scroll region: the list loads after the first paint, and growing in place would shift the uptime table and the SLA catalogue below it (CLS). */}
          <div className="flex h-[32rem] flex-col gap-om-12 overflow-y-auto" data-testid="service-groups">
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
                <Card
                  key={group.state}
                  as="section"
                  className="flex flex-col gap-om-10"
                  style={{
                    borderColor: group.state === 'healthy' ? undefined : stateColor(group.state) + '55',
                  }}
                >
                  <SectionTitle
                    as="h2"
                    size="sm"
                    action={
                      <Tag>{t('services.groupCount', { count: format.integer(group.items.length) })}</Tag>
                    }
                  >
                    <span className="flex items-center gap-om-8">
                      <Dot state={group.state} pulse={group.state === 'down'} />
                      {t(groupKey[group.state])}
                    </span>
                  </SectionTitle>
                  <ul className="flex flex-col gap-om-8">
                    {group.items.map((item) => {
                      const budgetPercent = errorBudgetPercent(
                        item.slaTarget,
                        item.errorBudgetRemainingMinutes,
                      );
                      const exhausted = item.errorBudgetRemainingMinutes <= 0;
                      const open = incidentsByService.get(item.service.id) ?? [];
                      const window = item.currentWindow;
                      const assigning =
                        assignment.isPending && assignment.variables.serviceId === item.service.id;
                      const selectId = 'sla-' + item.service.id;
                      return (
                        <li
                          key={item.service.id}
                          className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-12"
                          data-service-id={item.service.id}
                        >
                          <div className="flex flex-wrap items-center gap-om-10">
                            <StateBadge
                              state={item.state}
                              label={t(healthKey[item.state])}
                              live={item.state !== 'healthy'}
                            />
                            <Link
                              href={serviceHref(locale, item.service)}
                              className="min-w-0 font-om-display text-om-md font-bold text-om-primary hover:text-om-cyan"
                            >
                              {item.service.displayName}
                            </Link>
                            {open.length > 0 ? (
                              <Tag variant="state" state="down">
                                {t('services.openIncident')}
                              </Tag>
                            ) : null}
                            <span className="ms-auto text-om-2xs text-om-muted">
                              {t('services.since', { when: format.dateTime(item.since) })}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-om-8">
                            <Tag>{t('services.slaTarget', { target: format.number(item.slaTarget) })}</Tag>
                            <span className={cx('font-om-mono text-om-xs', availabilityTone(window))}>
                              {window.availabilityPercent === null
                                ? t('services.uptime.noData')
                                : t('services.window.availability', {
                                    percent: format.percent(window.availabilityPercent),
                                    window: t(windowLabelKey(item.sla?.window ?? null)),
                                  })}
                            </span>
                            {item.sla !== null ? (
                              <Tag>{t('services.sla.assigned', { name: item.sla.name })}</Tag>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-om-10">
                            <Bar
                              value={budgetPercent}
                              max={BSM.percentScale}
                              accent={
                                exhausted
                                  ? accents.rose
                                  : item.state === 'healthy'
                                    ? accents.emerald
                                    : accents.amber
                              }
                              label={t('services.errorBudget', {
                                minutes: format.integer(item.errorBudgetRemainingMinutes),
                              })}
                              className="flex-1"
                            />
                            <span
                              className={cx(
                                'whitespace-nowrap font-om-mono text-om-2xs',
                                exhausted ? 'text-om-rose' : 'text-om-secondary',
                              )}
                            >
                              {exhausted
                                ? t('services.errorBudgetExhausted', {
                                    minutes: format.integer(Math.abs(item.errorBudgetRemainingMinutes)),
                                  })
                                : t('services.errorBudget', {
                                    minutes: format.integer(item.errorBudgetRemainingMinutes),
                                  })}
                            </span>
                            {window.burnRate !== null && window.burnRate > 0 ? (
                              <Tag>{t('services.window.burn', { rate: format.number(window.burnRate) })}</Tag>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-om-6 text-om-xs">
                            <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                              {t('services.rootCauses')}
                            </span>
                            {item.rootCauses.length === 0 ? (
                              <span className="text-om-secondary">{t('services.noRootCause')}</span>
                            ) : (
                              item.rootCauses.map((cause) => (
                                <Link
                                  key={cause.id}
                                  href={ciHref(locale, cause)}
                                  className="rounded-om-tag border border-om-rose/30 bg-om-rose/10 px-om-8 py-om-4 text-om-rose hover:bg-om-rose/20"
                                >
                                  {cause.displayName}
                                </Link>
                              ))
                            )}
                            <label
                              htmlFor={selectId}
                              className="ms-auto flex items-center gap-om-4 text-om-2xs text-om-muted"
                            >
                              {t('services.sla.assign')}
                              <Select
                                id={selectId}
                                className="w-auto py-om-4"
                                value={item.sla?.id ?? ''}
                                disabled={!canOperate || assigning || !slas.isSuccess}
                                onChange={(e) => {
                                  assignment.mutate({
                                    serviceId: item.service.id,
                                    slaId: e.target.value === '' ? null : e.target.value,
                                  });
                                }}
                              >
                                <option value="">{t('services.sla.none')}</option>
                                {(slas.data ?? []).map((sla) => (
                                  <option key={sla.id} value={sla.id}>
                                    {sla.name}
                                  </option>
                                ))}
                              </Select>
                            </label>
                            <Link
                              href={mapHref(locale, item.service)}
                              className="flex items-center gap-om-4 text-om-cyan hover:underline"
                            >
                              <Icon name="dependencies" className="size-3.5" />
                              {t('services.showInMap')}
                            </Link>
                          </div>
                          {assignment.isError && assignment.variables.serviceId === item.service.id ? (
                            <p role="alert" className="text-om-2xs text-om-rose">
                              {t('services.sla.assignError')}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              ))
            )}
          </div>

          <UptimeTable
            locale={locale}
            rows={report.data ?? []}
            status={report.isPending ? 'pending' : report.isError ? 'error' : 'success'}
            onRetry={() => {
              void report.refetch();
            }}
            granularity={granularity}
            onGranularity={setGranularity}
            onExport={() => {
              exportCsv.mutate();
            }}
            exporting={exportCsv.isPending}
            exportError={exportCsv.isError}
          />

          <SlaPanel
            slas={slas.data ?? []}
            status={slas.isPending ? 'pending' : slas.isError ? 'error' : 'success'}
            onRetry={() => {
              void slas.refetch();
            }}
            canEdit={canOperate}
            onSave={saveSla}
            onDelete={removeSla}
          />
        </div>

        <Card as="aside" className="flex flex-col gap-om-12 self-start">
          <SectionTitle
            as="h2"
            size="sm"
            description={t('services.incidents.subtitle')}
            action={
              <Button
                tone="quiet"
                onClick={() => {
                  setShowResolved((v) => !v);
                }}
              >
                {showResolved ? t('services.incidents.showOpen') : t('services.incidents.showAll')}
              </Button>
            }
          >
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
              {incidents.data.map((incident) => (
                <IncidentCard
                  key={incident.id}
                  locale={locale}
                  incident={incident}
                  canOperate={canOperate}
                  actions={actions}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
