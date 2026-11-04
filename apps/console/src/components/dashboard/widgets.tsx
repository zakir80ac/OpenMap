'use client';
// REQ-UI-030 — the widget catalogue (ADR-020): one component per contract widget kind, every one painted from live
// queries (the estate aggregate, the screens' own queries), plus the registry the wizard, the customiser and the
// grid read: title, description, area, icon, the screen it links to and the default size.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { BSM, DASHBOARD, DCIM, POWER } from '@openmap/constants';
import { ASSET_STAGES, CI_LAYERS, PLAN_STATUSES, WIDGET_KINDS, type AssetStage, type WidgetKind, type WidgetSize } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Bar, Donut, Dot, Kpi, LayerBadge, Segmented, Sparkline, StateBadge, Tag, accents, layerColor, stateColors, type HexColor } from '@openmap/ui';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { Icon, type IconName } from '@/components/icons';
import { estateStatsQuery } from '@/lib/dashboard-queries';
import { assetsQuery, integrationsQuery, type Money } from '@/lib/estate-queries';
import { healthKey, layerKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { auditLogInfiniteQuery, currentSweepQuery, discoveryJobsQuery, discoveryNodesQuery, impactScenariosQuery, incidentsQuery, layersQuery, servicesQuery, tenantSettingsQuery } from '@/lib/queries';
import { useFormatters, useLocale, useT } from '@/providers';

export type WidgetArea = 'estate' | 'services' | 'operations' | 'security' | 'software' | 'assets' | 'finance' | 'platform';

export interface WidgetSpec {
  kind: WidgetKind;
  area: WidgetArea;
  icon: IconName;
  /** Screen the widget's header links to. */
  href: string;
  defaultSize: WidgetSize;
  Component: (props: WidgetProps) => ReactNode;
}

export interface WidgetProps {
  options: Record<string, unknown>;
}

export const WIDGET_AREAS: readonly WidgetArea[] = ['estate', 'services', 'operations', 'security', 'software', 'assets', 'finance', 'platform'];

export function widgetTitleKey(kind: WidgetKind): MessageKey {
  return `dashboard.widget.${kind}.title`;
}
export function widgetDescriptionKey(kind: WidgetKind): MessageKey {
  return `dashboard.widget.${kind}.desc`;
}
export function areaKey(area: WidgetArea): MessageKey {
  return `dashboard.area.${area}`;
}

const PENDING = '…';
const NODE_ONLINE = 'online';
const JOB_FAILED = 'failed';

function formatMoney(locale: string, money: Money): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency, maximumFractionDigits: 0 }).format(money.amount);
}

/** The largest total and how many other currencies the figure leaves out. */
function headlineMoney(locale: string, totals: readonly Money[], none: string): { value: string; more: number } {
  const first = totals[0];
  if (first === undefined) return { value: none, more: 0 };
  return { value: formatMoney(locale, first), more: totals.length - 1 };
}

/** Percent change between the first and the last value of a series; null without a non-zero start. */
export function trendDelta(series: readonly number[]): number | null {
  const first = series[0];
  const last = series[series.length - 1];
  if (first === undefined || last === undefined || first === 0) return null;
  return Math.round(((last - first) / first) * BSM.percentScale);
}

function useStats() {
  return useQuery(estateStatsQuery());
}

function Loading({ error, onRetry }: { error: boolean; onRetry: () => void }): ReactNode {
  return error ? <QueryState status="error" onRetry={onRetry} /> : <QueryState status="pending" />;
}

interface KpiTileProps {
  label: ReactNode;
  value: ReactNode;
  accent?: HexColor | undefined;
  delta?: number | null | undefined;
  deltaLabel?: string | undefined;
  lowerIsBetter?: boolean | undefined;
  unit?: ReactNode;
  spark?: readonly number[] | undefined;
  note?: ReactNode;
}

function KpiTile({ label, value, accent, delta, deltaLabel, lowerIsBetter, unit, spark, note }: KpiTileProps): ReactNode {
  return (
    <div className="flex h-full flex-col justify-between gap-om-10">
      <Kpi label={label} value={value} {...(accent !== undefined ? { accent } : {})} {...(delta !== null && delta !== undefined ? { delta, deltaLabel: deltaLabel ?? String(delta) + '%', lowerIsBetter: lowerIsBetter ?? false } : {})} {...(unit !== undefined ? { unit } : {})} />
      {spark !== undefined && spark.length > 1 ? <Sparkline values={spark} accent={accent ?? accents.cyan} height={DASHBOARD.sparklineHeightPx} /> : null}
      {note !== undefined ? <p className="text-om-2xs text-om-muted">{note}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Estate
// ---------------------------------------------------------------------------------------------------------------

function EstateCis(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const layers = useQuery(layersQuery());
  const stats = useStats();
  const total = (layers.data ?? []).reduce((sum, l) => sum + l.count, 0);
  const delta = stats.data ? trendDelta(stats.data.trend.cis) : null;
  return <KpiTile label={t('dashboard.widget.estate.cis.kpi')} value={layers.isSuccess ? format.integer(total) : PENDING} accent={accents.cyan} delta={delta} spark={stats.data?.trend.cis} note={t('dashboard.widget.trendNote', { days: format.integer(DASHBOARD.trendDays) })} />;
}

function EstateLayers(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const layers = useQuery(layersQuery());
  const byLayer = useMemo(() => new Map((layers.data ?? []).map((s) => [s.layer, s])), [layers.data]);
  const max = (layers.data ?? []).reduce((m, l) => Math.max(m, l.count), 0);
  if (!layers.isSuccess) return <Loading error={layers.isError} onRetry={() => void layers.refetch()} />;
  return (
    <ul className="flex flex-col gap-om-4">
      {CI_LAYERS.map((layer) => {
        const summary = byLayer.get(layer);
        const label = t(layerKey(layer));
        return (
          <li key={layer} className="flex items-center gap-om-10 py-om-4">
            <span className="w-36 shrink-0">
              <LayerBadge layer={layer} label={label} />
            </span>
            <Bar value={summary?.count ?? 0} max={max} accent={layerColor(layer)} label={label} className="flex-1" glowing={false} />
            <span className="w-14 text-end font-om-mono text-om-xs tabular-nums text-om-secondary">{format.integer(summary?.count ?? 0)}</span>
          </li>
        );
      })}
    </ul>
  );
}

type TrendRange = 'short' | 'full';

function EstateTrend(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const stats = useStats();
  const [range, setRange] = useState<TrendRange>('full');
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const take = range === 'short' ? DASHBOARD.trendShortDays : DASHBOARD.trendDays;
  const slice = (s: readonly number[]): number[] => s.slice(-take);
  const rows: Array<{ key: MessageKey; values: number[]; accent: HexColor }> = [
    { key: 'dashboard.trend.cis', values: slice(stats.data.trend.cis), accent: accents.cyan },
    { key: 'dashboard.trend.discoveryRuns', values: slice(stats.data.trend.discoveryRuns), accent: accents.violet },
    { key: 'dashboard.trend.events', values: slice(stats.data.trend.events), accent: accents.emerald },
    { key: 'dashboard.trend.incidents', values: slice(stats.data.trend.incidents), accent: accents.rose },
  ];
  return (
    <div className="flex flex-col gap-om-12">
      <div className="flex justify-end">
        <Segmented
          label={t('dashboard.trend.range')}
          value={range}
          onChange={setRange}
          options={[
            { value: 'short', label: t('dashboard.trend.days', { days: format.integer(DASHBOARD.trendShortDays) }) },
            { value: 'full', label: t('dashboard.trend.days', { days: format.integer(DASHBOARD.trendDays) }) },
          ]}
        />
      </div>
      <ul className="grid grid-cols-1 gap-om-12 sm:grid-cols-2">
        {rows.map((row) => {
          const last = row.values[row.values.length - 1] ?? 0;
          const delta = trendDelta(row.values);
          return (
            <li key={row.key} className="flex flex-col gap-om-4 rounded-om-panel border border-om-border-glass bg-om-surface2/50 p-om-10">
              <div className="flex items-baseline justify-between gap-om-8">
                <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-secondary">{t(row.key)}</span>
                <span className="font-om-display text-om-lg font-bold" style={{ color: row.accent }}>
                  {format.integer(last)}
                  {delta !== null ? <span className="ms-om-6 font-om-mono text-om-2xs text-om-muted">{(delta > 0 ? '+' : '') + String(delta)}%</span> : null}
                </span>
              </div>
              <Sparkline values={row.values} accent={row.accent} height={DASHBOARD.sparklineHeightPx} label={t(row.key)} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------------------------

function ServicesHealth(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const services = useQuery(servicesQuery());
  if (!services.isSuccess) return <Loading error={services.isError} onRetry={() => void services.refetch()} />;
  const list = services.data;
  const count = (state: string): number => list.filter((s) => s.state === state).length;
  const segments = (['healthy', 'degraded', 'down', 'unknown'] as const).map((state) => ({ value: count(state), accent: stateColors[state], label: t(healthKey[state]) }));
  return (
    <div className="flex items-center gap-om-16">
      <Donut segments={segments} centre={format.integer(count('healthy'))} caption={t('dashboard.kpi.healthy')} label={t('dashboard.serviceHealth')} />
      <ul className="flex flex-1 flex-col gap-om-6">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-om-8 text-om-xs">
            <span className="flex items-center gap-om-6 text-om-secondary">
              <span aria-hidden="true" className="inline-block size-2 rounded-om-pill" style={{ background: s.accent }} />
              {s.label}
            </span>
            <span className="font-om-mono tabular-nums text-om-primary">{format.integer(s.value)}</span>
          </li>
        ))}
        <li className="mt-om-4 border-t border-om-border-glass pt-om-6 text-om-2xs text-om-muted">{t('dashboard.widget.servicesTotal', { count: format.integer(list.length) })}</li>
      </ul>
    </div>
  );
}

function ServicesSla(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const services = useQuery(servicesQuery());
  if (!services.isSuccess) return <Loading error={services.isError} onRetry={() => void services.refetch()} />;
  const rows = [...services.data].sort((a, b) => a.errorBudgetRemainingMinutes - b.errorBudgetRemainingMinutes).slice(0, DASHBOARD.listRows);
  const max = rows.reduce((m, s) => Math.max(m, s.errorBudgetRemainingMinutes), 0);
  if (rows.length === 0) return <QueryState status="empty" />;
  return (
    <ul className="flex flex-col gap-om-6">
      {rows.map((s) => (
        <li key={s.service.id} className="flex items-center gap-om-10 text-om-xs">
          <StateBadge state={s.state} label={t(healthKey[s.state])} />
          <span className="min-w-0 flex-1 truncate text-om-primary">{s.service.displayName}</span>
          <Bar value={s.errorBudgetRemainingMinutes} max={max} accent={s.state === 'healthy' ? accents.emerald : accents.amber} label={s.service.displayName} className="w-28" glowing={false} />
          <span className="w-20 text-end font-om-mono tabular-nums text-om-secondary">{t('dashboard.errorBudget', { minutes: format.integer(s.errorBudgetRemainingMinutes) })}</span>
        </li>
      ))}
    </ul>
  );
}

function IncidentsOpen(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const incidents = useQuery(incidentsQuery(true));
  const stats = useStats();
  if (!incidents.isSuccess) return <Loading error={incidents.isError} onRetry={() => void incidents.refetch()} />;
  const open = incidents.data;
  return (
    <div className="flex flex-col gap-om-10">
      <KpiTile label={t('dashboard.widget.incidents.open.kpi')} value={format.integer(open.length)} accent={open.length > 0 ? accents.rose : accents.emerald} spark={stats.data?.trend.incidents} />
      <ul className="flex flex-col gap-om-4">
        {open.slice(0, DASHBOARD.listRows).map((i) => (
          <li key={i.id} className="flex items-center gap-om-8 text-om-xs">
            <Dot state="down" pulse />
            <span className="min-w-0 flex-1 truncate text-om-primary">{i.service.displayName}</span>
            <span className="font-om-mono text-om-2xs text-om-muted">{format.dateTime(i.openedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImpactRecent(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const locale = useLocale();
  const scenarios = useQuery(impactScenariosQuery());
  if (!scenarios.isSuccess) return <Loading error={scenarios.isError} onRetry={() => void scenarios.refetch()} />;
  if (scenarios.data.length === 0) return <QueryState status="empty" />;
  return (
    <ul className="flex flex-col gap-om-4">
      {scenarios.data.slice(0, DASHBOARD.listRows).map((s) => (
        <li key={s.id} className="flex items-center gap-om-8 text-om-xs">
          <Tag variant="neutral">{t(`impact.condition.${s.kind}.label` as MessageKey)}</Tag>
          <span className="min-w-0 flex-1 truncate text-om-primary">{s.name}</span>
          <span className="font-om-mono text-om-2xs text-om-muted">{format.dateTime(s.createdAt)}</span>
          <Link href={localizedHref(locale, '/impact')} className="text-om-cyan hover:underline">
            {t('impact.saved.run')}
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------------------------

function DiscoverySweep(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const sweep = useQuery(currentSweepQuery());
  if (!sweep.isSuccess) return <Loading error={sweep.isError} onRetry={() => void sweep.refetch()} />;
  const s = sweep.data;
  if (s === null) return <KpiTile label={t('dashboard.widget.discovery.sweep.kpi')} value={t('dashboard.widget.sweepIdle')} />;
  const running = s.finishedAt === null;
  return (
    <div className="flex h-full flex-col justify-between gap-om-10">
      <Kpi label={running ? t('dashboard.widget.sweepRunning') : t('dashboard.widget.sweepDone')} value={format.integer(s.devicesDiscovered)} unit={t('dashboard.widget.devices')} accent={accents.cyan} />
      <Bar value={s.targetsDone} max={Math.max(s.targetsTotal, 1)} label={t('dashboard.widget.discovery.sweep.title')} glowing={running} />
      <p className="text-om-2xs text-om-muted">{t('dashboard.widget.sweepTargets', { done: format.integer(s.targetsDone), total: format.integer(s.targetsTotal), minutes: format.integer(s.budgetMinutes) })}</p>
    </div>
  );
}

function DiscoveryNodes(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const nodes = useQuery(discoveryNodesQuery());
  if (!nodes.isSuccess) return <Loading error={nodes.isError} onRetry={() => void nodes.refetch()} />;
  const online = nodes.data.filter((n) => n.status === NODE_ONLINE).length;
  return (
    <div className="flex h-full flex-col justify-between gap-om-10">
      <Kpi label={t('dashboard.widget.discovery.nodes.kpi')} value={format.integer(online)} unit={t('dashboard.widget.ofTotal', { total: format.integer(nodes.data.length) })} accent={online === nodes.data.length ? accents.emerald : accents.amber} />
      <ul className="flex flex-col gap-om-4">
        {nodes.data.slice(0, DASHBOARD.listRows).map((n) => (
          <li key={n.id} className="flex items-center gap-om-8 text-om-xs">
            <Dot state={n.status === NODE_ONLINE ? 'healthy' : 'down'} pulse={n.status === NODE_ONLINE} />
            <span className="min-w-0 flex-1 truncate font-om-mono text-om-primary">{n.id}</span>
            <span className="text-om-2xs text-om-muted">{n.site?.displayName ?? ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiscoveryJobs(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const jobs = useQuery(discoveryJobsQuery(null));
  if (!jobs.isSuccess) return <Loading error={jobs.isError} onRetry={() => void jobs.refetch()} />;
  const rows = jobs.data.slice(0, DASHBOARD.listRows);
  const max = rows.reduce((m, j) => Math.max(m, j.cisEmitted), 0);
  if (rows.length === 0) return <QueryState status="empty" />;
  return (
    <ul className="flex flex-col gap-om-6">
      {rows.map((j) => (
        <li key={j.id} className="flex items-center gap-om-10 text-om-xs">
          <Dot state={j.status === JOB_FAILED ? 'down' : j.finishedAt === null ? 'unknown' : 'healthy'} pulse={j.finishedAt === null} />
          <span className="w-28 shrink-0 truncate font-om-mono text-om-primary">{j.collectorId}</span>
          <Bar value={j.cisEmitted} max={Math.max(max, 1)} accent={accents.violet} label={j.collectorId} className="flex-1" glowing={false} />
          <span className="w-16 text-end font-om-mono tabular-nums text-om-secondary">{format.integer(j.cisEmitted)}</span>
          {j.errors > 0 ? <Tag variant="state" state="down">{t('dashboard.widget.errors', { count: format.integer(j.errors) })}</Tag> : null}
        </li>
      ))}
    </ul>
  );
}

function IntegrationsHealth(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const integrations = useQuery(integrationsQuery(null));
  if (!integrations.isSuccess) return <Loading error={integrations.isError} onRetry={() => void integrations.refetch()} />;
  const healthy = integrations.data.filter((i) => i.health === 'healthy').length;
  const failed = integrations.data.reduce((sum, i) => sum + i.failedLastHour, 0);
  return (
    <div className="flex h-full flex-col justify-between gap-om-10">
      <Kpi label={t('dashboard.widget.integrations.health.kpi')} value={format.integer(healthy)} unit={t('dashboard.widget.ofTotal', { total: format.integer(integrations.data.length) })} accent={failed > 0 ? accents.amber : accents.emerald} />
      <p className="text-om-2xs text-om-muted">{t('dashboard.widget.failedLastHour', { count: format.integer(failed) })}</p>
    </div>
  );
}

function AuditRecent(): ReactNode {
  const format = useFormatters();
  const audit = useInfiniteQuery(auditLogInfiniteQuery({}));
  if (!audit.isSuccess) return <Loading error={audit.isError} onRetry={() => void audit.refetch()} />;
  const entries = (audit.data.pages[0]?.edges ?? []).map((e) => e.node).slice(0, DASHBOARD.listRows);
  if (entries.length === 0) return <QueryState status="empty" />;
  return (
    <ul className="flex flex-col divide-y divide-om-border-glass">
      {entries.map((e) => (
        <li key={e.id} className="flex items-center gap-om-10 py-om-6 text-om-xs">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-om-pill bg-om-violet/15 font-om-mono text-om-2xs uppercase text-om-violet">{e.actor.slice(0, 1)}</span>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-om-primary">{e.actor}</span> <span className="text-om-secondary">{e.action}</span> <span className="font-om-mono text-om-2xs text-om-muted">{e.subjectType}</span>
          </span>
          <span className="shrink-0 font-om-mono text-om-2xs text-om-muted">{format.dateTime(e.at)}</span>
        </li>
      ))}
    </ul>
  );
}

function PlatformSettings(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const settings = useQuery(tenantSettingsQuery());
  if (!settings.isSuccess) return <Loading error={settings.isError} onRetry={() => void settings.refetch()} />;
  const s = settings.data;
  const rows: Array<[MessageKey, string]> = [
    ['settings.tenant.discoveryIntervalMinutes', format.integer(s.discoveryIntervalMinutes)],
    ['settings.tenant.historyRetentionDays', format.integer(s.historyRetentionDays)],
    ['settings.tenant.auditRetentionDays', format.integer(s.auditRetentionDays)],
    ['settings.tenant.assistantEnabled', s.assistantEnabled ? t('common.yes') : t('common.no')],
    ['settings.tenant.outboundIntegrationsEnabled', s.outboundIntegrationsEnabled ? t('common.yes') : t('common.no')],
  ];
  return (
    <ul className="flex flex-col gap-om-4">
      {rows.map(([key, value]) => (
        <li key={key} className="flex items-center justify-between gap-om-8 text-om-xs">
          <span className="text-om-secondary">{t(key)}</span>
          <span className="font-om-mono tabular-nums text-om-primary">{value}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Security and software
// ---------------------------------------------------------------------------------------------------------------

function SecurityVulnerabilities(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const stats = useStats();
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const v = stats.data.vulnerabilities;
  const other = Math.max(v.total - v.critical - v.exploited, 0);
  return (
    <div className="flex items-center gap-om-16">
      <Donut
        segments={[
          { value: v.exploited, accent: accents.rose, label: t('dashboard.widget.vuln.exploited') },
          { value: Math.max(v.critical - v.exploited, 0), accent: accents.amber, label: t('dashboard.widget.vuln.critical') },
          { value: other, accent: accents.violetLight, label: t('dashboard.widget.vuln.other') },
        ]}
        centre={format.integer(v.total)}
        caption={t('dashboard.widget.vuln.total')}
        label={t('dashboard.widget.security.vulnerabilities.title')}
      />
      <ul className="grid flex-1 grid-cols-2 gap-om-8">
        {(
          [
            ['dashboard.widget.vuln.exploited', v.exploited, accents.rose],
            ['dashboard.widget.vuln.critical', v.critical, accents.amber],
            ['dashboard.widget.vuln.kev', v.cisaKev, accents.rose],
            ['dashboard.widget.vuln.patchAvailable', v.patchAvailable, accents.emerald],
          ] as const
        ).map(([key, value, accent]) => (
          <li key={key} className="flex flex-col gap-om-2">
            <span className="text-om-2xs uppercase tracking-[0.06em] text-om-secondary">{t(key)}</span>
            <span className="font-om-display text-om-lg font-bold" style={{ color: accent }}>
              {format.integer(value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SecurityExposure(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const stats = useStats();
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const v = stats.data.vulnerabilities;
  return <KpiTile label={t('dashboard.widget.security.exposure.kpi')} value={format.integer(v.internetFacing)} accent={v.internetFacing > 0 ? accents.rose : accents.emerald} note={t('dashboard.widget.exposureNote', { hosts: format.integer(v.affectedHosts) })} />;
}

function SoftwareEndOfSupport(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const stats = useStats();
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const n = stats.data.endOfSupport;
  return <KpiTile label={t('dashboard.widget.software.end_of_support.kpi')} value={format.integer(n)} accent={n > 0 ? accents.amber : accents.emerald} note={t('dashboard.widget.eosNote', { products: format.integer(stats.data.licences.products) })} />;
}

function SoftwareLicences(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const stats = useStats();
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const l = stats.data.licences;
  const attention = l.overDeployed + l.expired;
  return (
    <div className="flex h-full flex-col justify-between gap-om-8">
      <Kpi label={t('dashboard.widget.software.licences.kpi')} value={format.integer(attention)} accent={attention > 0 ? accents.amber : accents.emerald} unit={t('dashboard.widget.ofTotal', { total: format.integer(l.licensed) })} />
      <ul className="flex flex-col gap-om-2 text-om-2xs text-om-secondary">
        <li>{t('dashboard.widget.licencesOver', { count: format.integer(l.overDeployed) })}</li>
        <li>{t('dashboard.widget.licencesExpiring', { count: format.integer(l.expiringSoon), days: format.integer(DASHBOARD.licenceExpiryDays) })}</li>
        <li>{t('dashboard.widget.licencesExpired', { count: format.integer(l.expired) })}</li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Assets and finance
// ---------------------------------------------------------------------------------------------------------------

const STAGE_ACCENT: Record<AssetStage, HexColor> = {
  planned: accents.violet,
  in_stock: accents.sky,
  deployed: accents.emerald,
  spare: accents.cyan,
  rma: accents.amber,
  retired: accents.violetLight,
  disposed: accents.rose,
};

function AssetsStages(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const stats = useStats();
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const rows = stats.data.assetsByStage;
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return (
    <div className="flex items-center gap-om-16">
      <Donut segments={ASSET_STAGES.map((stage) => ({ value: rows.find((r) => r.stage === stage)?.count ?? 0, accent: STAGE_ACCENT[stage], label: t(`assets.stage.${stage}`) }))} centre={format.integer(total)} caption={t('dashboard.widget.assetsTotal')} label={t('dashboard.widget.assets.stages.title')} />
      <ul className="grid flex-1 grid-cols-2 gap-x-om-10 gap-y-om-4">
        {ASSET_STAGES.map((stage) => (
          <li key={stage} className="flex items-center justify-between gap-om-6 text-om-xs">
            <span className="flex items-center gap-om-6 text-om-secondary">
              <span aria-hidden="true" className="inline-block size-2 rounded-om-pill" style={{ background: STAGE_ACCENT[stage] }} />
              {t(`assets.stage.${stage}`)}
            </span>
            <span className="font-om-mono tabular-nums text-om-primary">{format.integer(rows.find((r) => r.stage === stage)?.count ?? 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssetsWarranty({ options }: WidgetProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const locale = useLocale();
  const horizon = typeof options['horizonDays'] === 'number' ? options['horizonDays'] : DASHBOARD.horizonDays;
  const assets = useQuery(assetsQuery({ warrantyExpiringWithinDays: horizon }, DASHBOARD.listRows));
  if (!assets.isSuccess) return <Loading error={assets.isError} onRetry={() => void assets.refetch()} />;
  if (assets.data.length === 0) return <QueryState status="empty" />;
  return (
    <ul className="flex flex-col divide-y divide-om-border-glass">
      {assets.data.map((a) => (
        <li key={a.id} className="flex items-center gap-om-10 py-om-6 text-om-xs">
          <Tag variant="state" state={a.supportContract === null ? 'degraded' : 'at_risk'}>
            {t(`assets.stage.${a.stage}`)}
          </Tag>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-om-primary">{a.ci?.displayName ?? a.assetTag}</span> <span className="text-om-muted">{a.manufacturer} {a.model}</span>
          </span>
          <span className="shrink-0 font-om-mono text-om-2xs text-om-amber">{a.warrantyEndsAt !== null ? format.dateTime(a.warrantyEndsAt) : t('dashboard.widget.noWarranty')}</span>
          <Link href={localizedHref(locale, '/assets')} className="text-om-cyan hover:underline">
            {t('common.open')}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function FinanceLicenceCost(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const locale = useLocale();
  const stats = useStats();
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const { value, more } = headlineMoney(locale, stats.data.licences.annualCost, t('dashboard.widget.noCost'));
  return <KpiTile label={t('dashboard.widget.finance.licence_cost.kpi')} value={value} accent={accents.violet} note={more > 0 ? t('dashboard.widget.moreCurrencies', { count: format.integer(more) }) : t('dashboard.widget.licencedProducts', { count: format.integer(stats.data.licences.licensed) })} />;
}

const IN_SERVICE_STAGES: readonly AssetStage[] = ['in_stock', 'deployed', 'spare'];

function FinanceAssetValue(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const locale = useLocale();
  const stats = useStats();
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const totals = new Map<string, number>();
  let count = 0;
  for (const row of stats.data.assetsByStage) {
    if (!IN_SERVICE_STAGES.includes(row.stage)) continue;
    count += row.count;
    for (const m of row.purchaseCost) totals.set(m.currency, (totals.get(m.currency) ?? 0) + m.amount);
  }
  const money = [...totals.entries()].map(([currency, amount]) => ({ amount, currency })).sort((a, b) => b.amount - a.amount);
  const { value, more } = headlineMoney(locale, money, t('dashboard.widget.noCost'));
  return <KpiTile label={t('dashboard.widget.finance.asset_value.kpi')} value={value} accent={accents.emerald} note={more > 0 ? t('dashboard.widget.moreCurrencies', { count: format.integer(more) }) : t('dashboard.widget.assetsInService', { count: format.integer(count) })} />;
}

function FinancePlans(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const locale = useLocale();
  const stats = useStats();
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const rows = stats.data.plans;
  const max = rows.reduce((m, r) => Math.max(m, r.estimatedCost[0]?.amount ?? 0), 0);
  return (
    <ul className="flex flex-col gap-om-6">
      {PLAN_STATUSES.map((status) => {
        const row = rows.find((r) => r.status === status);
        const cost = row?.estimatedCost[0];
        return (
          <li key={status} className="flex items-center gap-om-10 text-om-xs">
            <span className="w-24 shrink-0 text-om-secondary">{t(`assets.plans.status.${status}`)}</span>
            <span className="w-8 font-om-mono tabular-nums text-om-primary">{format.integer(row?.count ?? 0)}</span>
            <Bar value={cost?.amount ?? 0} max={Math.max(max, 1)} accent={status === 'live' ? accents.emerald : status === 'cancelled' ? accents.rose : accents.violet} label={t(`assets.plans.status.${status}`)} className="flex-1" glowing={false} />
            <span className="w-28 text-end font-om-mono tabular-nums text-om-secondary">{cost !== undefined ? formatMoney(locale, cost) : t('dashboard.widget.noCost')}</span>
          </li>
        );
      })}
    </ul>
  );
}

function DcimPower(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const stats = useStats();
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const p = stats.data.power;
  const load = p.ratedWatts === 0 ? 0 : (p.currentWatts / p.ratedWatts) * BSM.percentScale;
  return (
    <div className="flex h-full flex-col justify-between gap-om-10">
      <Kpi label={t('dashboard.widget.dcim.power.kpi')} value={format.number(p.currentWatts / POWER.wattsPerKilowatt)} unit={t('dashboard.widget.ofKw', { total: format.number(p.ratedWatts / POWER.wattsPerKilowatt) })} accent={load >= DCIM.criticalPowerPercent ? accents.rose : load >= DCIM.warnPowerPercent ? accents.amber : accents.cyan} />
      <Bar value={load} label={t('dashboard.widget.dcim.power.title')} accent={load >= DCIM.criticalPowerPercent ? accents.rose : load >= DCIM.warnPowerPercent ? accents.amber : accents.cyan} />
      <p className="text-om-2xs text-om-muted">{t('dashboard.widget.powerRacks', { count: format.integer(p.racks), percent: format.integer(load) })}</p>
    </div>
  );
}

function IpamUtilisation(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const stats = useStats();
  if (!stats.isSuccess) return <Loading error={stats.isError} onRetry={() => void stats.refetch()} />;
  const i = stats.data.ipam;
  return (
    <div className="flex h-full flex-col justify-between gap-om-10">
      <Kpi label={t('dashboard.widget.ipam.utilisation.kpi')} value={format.integer(i.averageUtilisationPercent)} unit="%" accent={i.critical > 0 ? accents.amber : accents.cyan} />
      <Bar value={i.averageUtilisationPercent} label={t('dashboard.widget.ipam.utilisation.title')} accent={i.critical > 0 ? accents.amber : accents.cyan} />
      <p className="text-om-2xs text-om-muted">{t('dashboard.widget.ipamNote', { subnets: format.integer(i.subnets), critical: format.integer(i.critical) })}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------

const SPECS: Record<WidgetKind, Omit<WidgetSpec, 'kind'>> = {
  'estate.cis': { area: 'estate', icon: 'cmdb', href: '/cmdb', defaultSize: 's', Component: EstateCis },
  'estate.layers': { area: 'estate', icon: 'layers', href: '/layers', defaultSize: 'm', Component: EstateLayers },
  'estate.trend': { area: 'estate', icon: 'analytics', href: '/analytics', defaultSize: 'l', Component: EstateTrend },
  'services.health': { area: 'services', icon: 'services', href: '/services', defaultSize: 'm', Component: ServicesHealth },
  'services.sla': { area: 'services', icon: 'services', href: '/services', defaultSize: 'm', Component: ServicesSla },
  'incidents.open': { area: 'services', icon: 'impact', href: '/services', defaultSize: 's', Component: IncidentsOpen },
  'impact.recent': { area: 'services', icon: 'impact', href: '/impact', defaultSize: 'm', Component: ImpactRecent },
  'discovery.sweep': { area: 'operations', icon: 'discovery', href: '/discovery', defaultSize: 's', Component: DiscoverySweep },
  'discovery.nodes': { area: 'operations', icon: 'site', href: '/discovery', defaultSize: 's', Component: DiscoveryNodes },
  'discovery.jobs': { area: 'operations', icon: 'discovery', href: '/discovery', defaultSize: 'm', Component: DiscoveryJobs },
  'security.vulnerabilities': { area: 'security', icon: 'shield', href: '/vulnerabilities', defaultSize: 'm', Component: SecurityVulnerabilities },
  'security.exposure': { area: 'security', icon: 'globe', href: '/vulnerabilities', defaultSize: 's', Component: SecurityExposure },
  'software.end_of_support': { area: 'software', icon: 'software', href: '/software', defaultSize: 's', Component: SoftwareEndOfSupport },
  'software.licences': { area: 'software', icon: 'tag', href: '/software', defaultSize: 's', Component: SoftwareLicences },
  'assets.stages': { area: 'assets', icon: 'assets', href: '/assets', defaultSize: 'm', Component: AssetsStages },
  'assets.warranty': { area: 'assets', icon: 'clock', href: '/assets', defaultSize: 'xl', Component: AssetsWarranty },
  'finance.licence_cost': { area: 'finance', icon: 'tag', href: '/software', defaultSize: 's', Component: FinanceLicenceCost },
  'finance.asset_value': { area: 'finance', icon: 'assets', href: '/assets', defaultSize: 's', Component: FinanceAssetValue },
  'finance.plans': { area: 'finance', icon: 'assets', href: '/assets', defaultSize: 'xl', Component: FinancePlans },
  'dcim.power': { area: 'operations', icon: 'dcim', href: '/dcim', defaultSize: 's', Component: DcimPower },
  'ipam.utilisation': { area: 'operations', icon: 'ipam', href: '/ipam', defaultSize: 's', Component: IpamUtilisation },
  'integrations.health': { area: 'operations', icon: 'integrations', href: '/integrations', defaultSize: 's', Component: IntegrationsHealth },
  'audit.recent': { area: 'platform', icon: 'eye', href: '/settings', defaultSize: 'xl', Component: AuditRecent },
  'platform.settings': { area: 'platform', icon: 'settings', href: '/settings', defaultSize: 's', Component: PlatformSettings },
};

export const WIDGET_REGISTRY: ReadonlyArray<WidgetSpec> = WIDGET_KINDS.map((kind) => ({ kind, ...SPECS[kind] }));

export function widgetSpec(kind: WidgetKind): WidgetSpec {
  return { kind, ...SPECS[kind] };
}

/** Tailwind column spans per size on the four-column grid. */
export const SIZE_CLASS: Record<WidgetSize, string> = {
  s: '',
  m: 'sm:col-span-2',
  l: 'sm:col-span-2 xl:col-span-3',
  xl: 'sm:col-span-2 xl:col-span-4',
};

export function WidgetIcon({ kind }: { kind: WidgetKind }): ReactNode {
  return <Icon name={SPECS[kind].icon} />;
}
