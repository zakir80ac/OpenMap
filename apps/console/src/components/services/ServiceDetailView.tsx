'use client';
// REQ-UI-012 REQ-BSM-006 REQ-BSM-008 — one business service: state, SLA and current window, uptime per month, quarter
// or year with the incidents open in each period, and every incident of the service with its response actions and RCA
// (ADR-024). Route /services/[id].
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { CONSOLE, ROLES, SLA, type AvailabilityGranularity } from '@openmap/constants';
import type { Locale } from '@openmap/i18n';
import { Bar, Card, Kpi, SectionTitle, StateBadge, Tag, accents } from '@openmap/ui';
import { useState, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { useCan } from '@/lib/auth';
import { healthKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import {
  acknowledgeIncident,
  assignIncident,
  availabilityReportCsv,
  closeIncident,
  incidentsQuery,
  resolveIncident,
  serviceAvailabilityQuery,
  serviceQuery,
  updateIncidentRca,
  type RcaInput,
  type ServiceAvailability,
} from '@/lib/queries';
import { useFormatters, useT } from '@/providers';
import { IncidentCard, type IncidentActions } from './IncidentCard';
import { windowKey } from './SlaPanel';
import { UptimeTable, availabilityTone } from './UptimeTable';
import { downloadCsv, windowLabelKey } from './ServicesView';

export interface ServiceDetailViewProps {
  locale: Locale;
  id: string;
}

export function ServiceDetailView({ locale, id }: ServiceDetailViewProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const can = useCan();
  const canOperate = can(ROLES.operator);
  const [granularity, setGranularity] = useState<AvailabilityGranularity>('month');
  const service = useQuery({ ...serviceQuery(id), refetchInterval: CONSOLE.livePollMs });
  const periods = useQuery(serviceAvailabilityQuery(id, granularity, SLA.defaultPeriods[granularity]));
  const incidents = useQuery({ ...incidentsQuery(false, id), refetchInterval: CONSOLE.livePollMs });
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['incidents'] });
    await queryClient.invalidateQueries({ queryKey: ['service', id] });
    await queryClient.invalidateQueries({ queryKey: ['serviceAvailability', id] });
  };
  const exportCsv = useMutation({
    mutationFn: () =>
      availabilityReportCsv(granularity, SLA.defaultPeriods[granularity]).then((csv) => {
        downloadCsv(csv, granularity);
      }),
  });
  const actions: IncidentActions = {
    acknowledge: (incidentId) => acknowledgeIncident(incidentId).then(refresh),
    assign: (incidentId, assignee) => assignIncident(incidentId, assignee).then(refresh),
    resolve: (incidentId, note) => resolveIncident(incidentId, note).then(refresh),
    close: (incidentId) => closeIncident(incidentId).then(refresh),
    saveRca: (incidentId, input: RcaInput) => updateIncidentRca(incidentId, input).then(refresh),
  };

  if (service.isPending) {
    return (
      <Card>
        <QueryState status="pending" />
      </Card>
    );
  }
  if (service.isError) {
    return (
      <Card>
        <QueryState
          status="error"
          onRetry={() => {
            void service.refetch();
          }}
        />
      </Card>
    );
  }
  const view = service.data;
  if (view === null) {
    return (
      <Card>
        <QueryState status="empty" />
        <p className="mt-om-8 text-om-sm text-om-secondary">{t('services.detail.notFound')}</p>
        <Link
          href={localizedHref(locale, '/services')}
          className="mt-om-8 inline-block text-om-xs text-om-cyan hover:underline"
        >
          {t('services.detail.back')}
        </Link>
      </Card>
    );
  }
  const window = view.currentWindow;
  const rows: ServiceAvailability[] = [
    { service: { ...view.service, code: view.service.id }, sla: view.sla, periods: periods.data ?? [] },
  ];
  return (
    <div className="flex flex-col gap-om-20" data-testid="service-detail">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={t('services.detail.title')}
        description={t('services.detail.subtitle')}
        action={
          <Link href={localizedHref(locale, '/services')} className="text-om-xs text-om-cyan hover:underline">
            {t('services.detail.back')}
          </Link>
        }
      >
        <span className="flex items-center gap-om-10">
          <StateBadge state={view.state} label={t(healthKey[view.state])} live={view.state !== 'healthy'} />
          {view.service.displayName}
        </span>
      </SectionTitle>

      <section className="grid grid-cols-2 gap-om-12 xl:grid-cols-4">
        <Card padding="16">
          <Kpi
            label={t('services.sla.assign')}
            value={view.sla === null ? t('services.sla.none') : view.sla.name}
          />
        </Card>
        <Card padding="16">
          <Kpi
            label={t('services.uptime.target')}
            value={
              window.targetPercent === null
                ? t('services.uptime.noTarget')
                : format.percent(window.targetPercent) + '%'
            }
          />
        </Card>
        <Card padding="16">
          <Kpi
            label={t(windowLabelKey(view.sla?.window ?? null))}
            value={
              <span className={availabilityTone(window)}>
                {window.availabilityPercent === null
                  ? t('services.uptime.noData')
                  : format.percent(window.availabilityPercent) + '%'}
              </span>
            }
          />
        </Card>
        <Card padding="16">
          <Kpi
            label={t('services.kpi.incidents')}
            value={
              incidents.isSuccess
                ? format.integer(
                    incidents.data.filter((i) => i.state !== 'resolved' && i.state !== 'closed').length,
                  )
                : '…'
            }
            accent={accents.violet}
          />
        </Card>
      </section>

      {window.budgetMinutes !== null && window.budgetRemainingMinutes !== null ? (
        <Card className="flex flex-col gap-om-8">
          <div className="flex flex-wrap items-center gap-om-8 text-om-xs text-om-secondary">
            <Bar
              value={Math.max(0, window.budgetRemainingMinutes)}
              max={Math.max(1, window.budgetMinutes)}
              accent={window.budgetRemainingMinutes <= 0 ? accents.rose : accents.emerald}
              label={t('services.window.budget', {
                remaining: format.integer(Math.max(0, window.budgetRemainingMinutes)),
                budget: format.integer(window.budgetMinutes),
              })}
              className="flex-1"
            />
            <span className="font-om-mono">
              {t('services.window.budget', {
                remaining: format.integer(Math.max(0, window.budgetRemainingMinutes)),
                budget: format.integer(window.budgetMinutes),
              })}
            </span>
            {window.burnRate !== null ? (
              <Tag>{t('services.window.burn', { rate: format.number(window.burnRate) })}</Tag>
            ) : null}
            {view.sla !== null ? <Tag>{t(windowKey[view.sla.window])}</Tag> : null}
          </div>
          {view.rootCauses.length > 0 ? (
            <div className="flex flex-wrap items-center gap-om-6 text-om-xs">
              <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">
                {t('services.detail.rootCauses')}
              </span>
              {view.rootCauses.map((cause) => (
                <Link
                  key={cause.id}
                  href={localizedHref(locale, '/cmdb/' + encodeURIComponent(cause.id))}
                  className="rounded-om-tag border border-om-rose/30 bg-om-rose/10 px-om-8 py-om-4 text-om-rose hover:bg-om-rose/20"
                >
                  {cause.displayName}
                </Link>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      <UptimeTable
        locale={locale}
        rows={rows}
        status={periods.isPending ? 'pending' : periods.isError ? 'error' : 'success'}
        onRetry={() => {
          void periods.refetch();
        }}
        granularity={granularity}
        onGranularity={setGranularity}
        onExport={() => {
          exportCsv.mutate();
        }}
        exporting={exportCsv.isPending}
        exportError={exportCsv.isError}
      />

      <Card as="section" className="flex flex-col gap-om-12" aria-labelledby="service-incidents-title">
        <SectionTitle as="h2" size="sm">
          <span id="service-incidents-title">{t('services.detail.incidents')}</span>
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
          <p className="text-om-sm text-om-secondary">{t('services.detail.incidentsEmpty')}</p>
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
  );
}
