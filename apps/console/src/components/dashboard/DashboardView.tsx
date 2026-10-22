'use client';
// REQ-UI-004 — Dashboard: KPI tiles, service health and the layer summary, from the `layers` and `services` queries.
import { useQuery } from '@tanstack/react-query';
import { CI_LAYERS } from '@openmap/contracts';
import { Bar, Card, Dot, Kpi, LayerBadge, Pill, SectionTitle, StateBadge, accents, layerColor } from '@openmap/ui';
import { useMemo, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { healthKey, layerKey } from '@/lib/keys';
import { layersQuery, servicesQuery } from '@/lib/queries';
import { useFormatters, useT } from '@/providers';

const PENDING_VALUE = '…';

export function DashboardView(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const layers = useQuery(layersQuery());
  const services = useQuery(servicesQuery());

  const totals = useMemo(() => {
    const summaries = layers.data ?? [];
    const list = services.data ?? [];
    return {
      cis: summaries.reduce((sum, layer) => sum + layer.count, 0),
      maxCount: summaries.reduce((max, layer) => Math.max(max, layer.count), 0),
      services: list.length,
      healthy: list.filter((s) => s.state === 'healthy').length,
      down: list.filter((s) => s.state === 'down').length,
    };
  }, [layers.data, services.data]);

  const byLayer = useMemo(() => new Map((layers.data ?? []).map((summary) => [summary.layer, summary])), [layers.data]);
  const value = (ready: boolean, n: number): string => (ready ? format.integer(n) : PENDING_VALUE);

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('dashboard.subtitle')}>
        {t('nav.dashboard')}
      </SectionTitle>

      <section className="grid grid-cols-1 gap-om-16 sm:grid-cols-2 xl:grid-cols-4" aria-busy={layers.isPending || services.isPending}>
        <Card>
          <Kpi label={t('dashboard.kpi.cis')} value={value(layers.isSuccess, totals.cis)} accent={accents.cyan} />
        </Card>
        <Card>
          <Kpi label={t('dashboard.kpi.services')} value={value(services.isSuccess, totals.services)} />
        </Card>
        <Card>
          <Kpi label={t('dashboard.kpi.healthy')} value={value(services.isSuccess, totals.healthy)} accent={accents.emerald} />
        </Card>
        <Card>
          <Kpi
            label={t('dashboard.kpi.down')}
            value={value(services.isSuccess, totals.down)}
            {...(totals.down > 0 ? { accent: accents.rose } : {})}
          />
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-om-16 xl:grid-cols-[3fr_2fr]">
        <Card as="section" className="flex flex-col gap-om-16">
          <SectionTitle
            size="sm"
            action={
              <Pill variant="primary" icon={<Dot state="healthy" pulse />}>
                {t('topbar.now')}
              </Pill>
            }
          >
            {t('dashboard.serviceHealth')}
          </SectionTitle>
          {services.isPending ? (
            <QueryState status="pending" />
          ) : services.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void services.refetch();
              }}
            />
          ) : services.data.length === 0 ? (
            <QueryState status="empty" />
          ) : (
            <ul className="flex flex-col">
              {services.data.map((item) => (
                <li key={item.service.id} className="flex items-center gap-om-12 border-b border-om-border-glass py-om-10 last:border-b-0">
                  <StateBadge state={item.state} label={t(healthKey[item.state])} live={item.state !== 'healthy'} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-om-sm font-medium text-om-primary">{item.service.displayName}</p>
                    <p className="truncate font-om-mono text-om-2xs text-om-muted">{item.service.name}</p>
                  </div>
                  <div className="flex flex-col items-end gap-om-4 text-om-2xs text-om-secondary">
                    <span>{t('dashboard.slaTarget', { target: format.number(item.slaTarget) })}</span>
                    <span>{t('dashboard.errorBudget', { minutes: format.integer(item.errorBudgetRemainingMinutes) })}</span>
                    {item.rootCauses.length > 0 ? (
                      <span className="text-om-rose">{t('dashboard.rootCauses', { count: format.integer(item.rootCauses.length) })}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card as="section" className="flex flex-col gap-om-16">
          <SectionTitle size="sm" description={t('dashboard.kpi.cis')}>
            {t('dashboard.layerSummary')}
          </SectionTitle>
          {layers.isPending ? (
            <QueryState status="pending" />
          ) : layers.isError ? (
            <QueryState
              status="error"
              onRetry={() => {
                void layers.refetch();
              }}
            />
          ) : (
            <ul className="flex flex-col gap-om-4">
              {CI_LAYERS.map((layer) => {
                const summary = byLayer.get(layer);
                const label = t(layerKey(layer));
                return (
                  <li key={layer} className="flex items-center gap-om-12 py-om-6">
                    <span className="w-44 shrink-0">
                      <LayerBadge layer={layer} label={label} />
                    </span>
                    <Bar value={summary?.count ?? 0} max={totals.maxCount} accent={layerColor(layer)} label={label} className="flex-1" />
                    <span className="w-16 text-end font-om-mono text-om-xs tabular-nums text-om-secondary">
                      {summary === undefined ? PENDING_VALUE : format.integer(summary.count)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
