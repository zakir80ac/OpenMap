'use client';
// REQ-PERF-005 (ADR-071) — Platform health, for administrators: OpenMap watching itself. The SLO indicators against
// their objectives (the same catalogue the Prometheus alert rules fire on), the firing and pending SLO alerts, every
// scrape target with its request rate, p95, 5xx share, event-loop delay, memory and CPU, the stores the reconciler
// probes and OpenBao's seal, the outbox and queue backlogs, and the perf budget results against PERF_BUDGETS (the
// checks CI runs). Everything comes from `platformHealth`, read from the stack's own Prometheus over a chosen window.
import { useQuery } from '@tanstack/react-query';
import { PLATFORM_HEALTH, ROLES, TIME, type PlatformWindowMinutes } from '@openmap/constants';
import type { PerfBudgetCheck } from '@openmap/contracts';
import { Card, Kpi, SectionTitle, Segmented, StateBadge, Tag, type UiState } from '@openmap/ui';
import { useState, type ReactNode } from 'react';
import { rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { useCan } from '@/lib/auth';
import type { Formatters } from '@/lib/format';
import {
  platformHealthQuery,
  type PlatformHealth,
  type PlatformSli,
  type PlatformStore,
  type SliStatus,
  type TargetHealth,
} from '@/lib/platform-queries';
import { useFormatters, useT, type Translate } from '@/providers';

const SLI_STATE: Record<SliStatus, UiState> = { ok: 'healthy', breach: 'down', no_data: 'unknown' };
const TARGET_STATE: Record<TargetHealth, UiState> = { up: 'healthy', down: 'down', unknown: 'unknown' };
const SECONDS_PER_HOUR = TIME.msPerHour / TIME.msPerSecond;
const KNOWN_STORES: readonly string[] = PLATFORM_HEALTH.stores;

/** A duration in seconds in the unit a person reads it in: milliseconds under a second, hours past one. */
export function duration(t: Translate, format: Formatters, seconds: number): string {
  if (seconds < 1) return t('platform.unit.ms', { value: format.integer(seconds * TIME.msPerSecond) });
  if (seconds < SECONDS_PER_HOUR) return t('platform.unit.s', { value: format.number(seconds) });
  return t('platform.unit.h', { value: format.number(seconds / SECONDS_PER_HOUR) });
}

export function ratio(t: Translate, format: Formatters, value: number): string {
  return t('platform.unit.percent', { value: format.number(value * PLATFORM_HEALTH.percentScale) });
}

export function sliValue(t: Translate, format: Formatters, sli: Pick<PlatformSli, 'unit'>, value: number | null): string {
  if (value === null) return t('platform.noData');
  if (sli.unit === 'seconds') return duration(t, format, value);
  if (sli.unit === 'ratio') return ratio(t, format, value);
  return format.integer(value);
}

function storeState(s: PlatformStore): UiState {
  if (s.up === null) return 'unknown';
  return s.up ? 'healthy' : 'down';
}

function storeName(t: Translate, store: string): string {
  return KNOWN_STORES.includes(store) ? t(`platform.store.${store as (typeof PLATFORM_HEALTH.stores)[number]}`) : store;
}

function budgetValue(t: Translate, format: Formatters, c: PerfBudgetCheck, value: number): string {
  if (c.measure === 'p95Ms') return t('platform.unit.ms', { value: format.number(value) });
  if (c.measure === 'fps') return t('platform.unit.fps', { value: format.number(value) });
  if (c.measure === 'minutes') return t('platform.unit.min', { value: format.number(value) });
  return format.number(value);
}

const dash = (v: string | null): string => v ?? '–';

function Panel({ health, windowMinutes }: { health: PlatformHealth; windowMinutes: PlatformWindowMinutes }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const up = health.targets.filter((x) => x.health === 'up').length;
  const storesUp = health.stores.filter((s) => s.up === true).length;
  const met = health.slis.filter((s) => s.status === 'ok').length;
  const firing = health.alerts.filter((a) => a.state === 'firing').length;
  const mib = (bytes: number): string => t('platform.unit.mib', { value: format.integer(bytes / PLATFORM_HEALTH.bytesPerMebibyte) });
  return (
    <>
      {health.prometheus.reachable ? null : (
        <section data-testid="prometheus-unreachable">
          <Card  padding="16" className="flex flex-col gap-om-6">
            <StateBadge state="down" label={t('platform.prometheus.unreachable')} />
            <span className="font-om-mono text-om-2xs text-om-secondary">
              <bdi>{health.prometheus.error ?? ''}</bdi>
            </span>
          </Card>
        </section>
      )}

      <div className="grid grid-cols-2 gap-om-12 md:grid-cols-4" data-testid="platform-kpis">
        <Kpi label={t('platform.kpi.targets')} value={t('platform.kpi.of', { value: format.integer(up), total: format.integer(health.targets.length) })} />
        <Kpi label={t('platform.kpi.stores')} value={t('platform.kpi.of', { value: format.integer(storesUp), total: format.integer(health.stores.length) })} />
        <Kpi label={t('platform.kpi.slos')} value={t('platform.kpi.of', { value: format.integer(met), total: format.integer(health.slis.length) })} />
        <Kpi label={t('platform.kpi.firing')} value={format.integer(firing)} delta={firing} deltaLabel="" lowerIsBetter />
      </div>

      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle as="h2" size="sm" description={t('platform.slis.subtitle', { minutes: format.integer(windowMinutes) })}>
          {t('platform.slis.title')}
        </SectionTitle>
        <div className="overflow-x-auto">
          <table className={tableClass} aria-label={t('platform.slis.title')}>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>{t('platform.slis.col.indicator')}</th>
                <th scope="col" className={thClass}>{t('platform.slis.col.value')}</th>
                <th scope="col" className={thClass}>{t('platform.slis.col.objective')}</th>
                <th scope="col" className={thClass}>{t('platform.slis.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {health.slis.map((s) => (
                <tr key={s.id} className={rowClass} data-sli={s.id} data-status={s.status}>
                  <td className={tdClass + ' text-om-primary'}>{t(`platform.sli.${s.id}`)}</td>
                  <td className={tdClass + ' font-om-mono'}>{sliValue(t, format, s, s.value)}</td>
                  <td className={tdClass + ' font-om-mono text-om-secondary'}>
                    {t('platform.slis.atMost', { value: sliValue(t, format, s, s.objective) })}
                  </td>
                  <td className={tdClass}>
                    <Tag variant="state" state={SLI_STATE[s.status]}>
                      {t(`platform.status.${s.status}`)}
                    </Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <section data-testid="platform-alerts">
        <Card  padding="24" className="flex flex-col gap-om-12">
          <SectionTitle as="h2" size="sm" description={t('platform.alerts.subtitle')}>
            {t('platform.alerts.title')}
          </SectionTitle>
          {health.alerts.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('platform.alerts.none')}</p>
          ) : (
            <ul className="flex flex-col gap-om-8">
              {health.alerts.map((a) => (
                <li key={a.name + (a.subject ?? '')} className="flex flex-wrap items-center gap-om-10" data-state={a.state}>
                  <StateBadge state={a.state === 'firing' ? 'down' : 'degraded'} label={t(`platform.alerts.state.${a.state}`)} />
                  <span className="text-om-sm text-om-primary">{a.sli === null ? a.name : t(`platform.sli.${a.sli}`)}</span>
                  {a.subject === null ? null : (
                    <span className="font-om-mono text-om-2xs text-om-secondary">
                      <bdi>{a.subject}</bdi>
                    </span>
                  )}
                  {a.activeAt === null ? null : (
                    <span className="text-om-2xs text-om-muted">{t('platform.alerts.since', { at: format.dateTime(a.activeAt) })}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <Card padding="24" className="flex flex-col gap-om-16">
        <SectionTitle as="h2" size="sm" description={t('platform.targets.subtitle')}>
          {t('platform.targets.title')}
        </SectionTitle>
        <div className="overflow-x-auto">
          <table className={tableClass} aria-label={t('platform.targets.title')}>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>{t('platform.targets.col.service')}</th>
                <th scope="col" className={thClass}>{t('platform.targets.col.health')}</th>
                <th scope="col" className={thClass}>{t('platform.targets.col.rate')}</th>
                <th scope="col" className={thClass}>{t('platform.targets.col.p95')}</th>
                <th scope="col" className={thClass}>{t('platform.targets.col.errors')}</th>
                <th scope="col" className={thClass}>{t('platform.targets.col.lag')}</th>
                <th scope="col" className={thClass}>{t('platform.targets.col.memory')}</th>
                <th scope="col" className={thClass}>{t('platform.targets.col.cpu')}</th>
                <th scope="col" className={thClass}>{t('platform.targets.col.scraped')}</th>
              </tr>
            </thead>
            <tbody>
              {health.targets.map((x) => (
                <tr key={x.job + x.instance} className={rowClass} data-service={x.service} data-health={x.health}>
                  <td className={tdClass + ' font-om-mono text-om-primary'}>
                    <bdi>{x.service}</bdi>
                    <span className="block text-om-2xs text-om-muted">
                      <bdi>{x.job}</bdi>
                    </span>
                    {x.lastError === null ? null : (
                      <span className="block font-om-body text-om-2xs text-om-rose">
                        <bdi>{x.lastError}</bdi>
                      </span>
                    )}
                  </td>
                  <td className={tdClass}>
                    <Tag variant="state" state={TARGET_STATE[x.health]}>
                      {t(`platform.health.${x.health}`)}
                    </Tag>
                  </td>
                  <td className={tdClass + ' font-om-mono'}>
                    {dash(x.requestRate === null ? null : t('platform.unit.perSecond', { value: format.number(x.requestRate) }))}
                  </td>
                  <td className={tdClass + ' font-om-mono'}>
                    {dash(x.p95Ms === null ? null : t('platform.unit.ms', { value: format.integer(x.p95Ms) }))}
                  </td>
                  <td className={tdClass + ' font-om-mono'}>{dash(x.errorRatio === null ? null : ratio(t, format, x.errorRatio))}</td>
                  <td className={tdClass + ' font-om-mono'}>
                    {dash(x.eventLoopP99Ms === null ? null : t('platform.unit.ms', { value: format.number(x.eventLoopP99Ms) }))}
                  </td>
                  <td className={tdClass + ' font-om-mono'}>{dash(x.residentBytes === null ? null : mib(x.residentBytes))}</td>
                  <td className={tdClass + ' font-om-mono'}>
                    {dash(x.cpuCores === null ? null : t('platform.unit.cores', { value: format.number(x.cpuCores) }))}
                  </td>
                  <td className={tdClass + ' whitespace-nowrap text-om-secondary'}>
                    {dash(x.lastScrapeAt === null ? null : format.dateTime(x.lastScrapeAt))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-om-16 lg:grid-cols-2">
        <Card padding="24" className="flex flex-col gap-om-12">
          <SectionTitle as="h2" size="sm" description={t('platform.stores.subtitle')}>
            {t('platform.stores.title')}
          </SectionTitle>
          <ul className="grid grid-cols-2 gap-om-10" aria-label={t('platform.stores.title')}>
            {health.stores.map((s) => (
              <li key={s.store} className="flex flex-col gap-om-4" data-store={s.store} data-up={String(s.up)}>
                <StateBadge state={storeState(s)} label={storeName(t, s.store)} />
                <span className="font-om-mono text-om-2xs text-om-muted">
                  {s.up === null
                    ? t('platform.noData')
                    : s.probeMs === null
                      ? t(s.up ? 'platform.stores.up' : 'platform.stores.down')
                      : t('platform.stores.probe', { value: format.integer(s.probeMs) })}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <section data-testid="platform-backlog">
          <Card  padding="24" className="flex flex-col gap-om-12">
            <SectionTitle as="h2" size="sm" description={t('platform.backlog.subtitle')}>
              {t('platform.backlog.title')}
            </SectionTitle>
            <dl className="grid grid-cols-2 gap-om-10">
              <div className="flex flex-col gap-om-4">
                <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('platform.backlog.pending')}</dt>
                <dd className="font-om-mono text-om-sm text-om-primary">
                  {health.outbox.pending === null ? t('platform.noData') : format.integer(health.outbox.pending)}
                </dd>
              </div>
              <div className="flex flex-col gap-om-4">
                <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('platform.backlog.oldest')}</dt>
                <dd className="font-om-mono text-om-sm text-om-primary">
                  {health.outbox.oldestAgeSeconds === null ? t('platform.noData') : duration(t, format, health.outbox.oldestAgeSeconds)}
                </dd>
              </div>
              <div className="flex flex-col gap-om-4">
                <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('platform.backlog.delivered')}</dt>
                <dd className="font-om-mono text-om-sm text-om-primary">
                  {health.outbox.deliveredPerSecond === null
                    ? t('platform.noData')
                    : t('platform.unit.perSecond', { value: format.number(health.outbox.deliveredPerSecond) })}
                </dd>
              </div>
              <div className="flex flex-col gap-om-4">
                <dt className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('platform.backlog.failures')}</dt>
                <dd className="font-om-mono text-om-sm text-om-primary">
                  {health.outbox.failuresPerSecond === null
                    ? t('platform.noData')
                    : t('platform.unit.perSecond', { value: format.number(health.outbox.failuresPerSecond) })}
                </dd>
              </div>
            </dl>
            {health.queues.length === 0 ? (
              <p className="text-om-2xs text-om-muted">{t('platform.queues.none')}</p>
            ) : (
              <table className={tableClass} aria-label={t('platform.queues.title')}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>{t('platform.queues.col.queue')}</th>
                    {PLATFORM_HEALTH.queueStates.map((state) => (
                      <th key={state} scope="col" className={thClass}>
                        {t(`platform.queues.state.${state}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {health.queues.map((q) => (
                    <tr key={q.queue} className={rowClass} data-queue={q.queue}>
                      <td className={tdClass + ' font-om-mono text-om-primary'}>
                        <bdi>{q.queue}</bdi>
                      </td>
                      {PLATFORM_HEALTH.queueStates.map((state) => (
                        <td key={state} className={tdClass + ' font-om-mono'}>
                          {format.integer(q[state])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </section>
      </div>

      <section data-testid="platform-budgets">
        <Card  padding="24" className="flex flex-col gap-om-16">
          <SectionTitle as="h2" size="sm" description={t('platform.budgets.subtitle')}>
            {t('platform.budgets.title')}
          </SectionTitle>
          {!health.budgets.configured ? (
            <p className="text-om-sm text-om-secondary">{t('platform.budgets.unconfigured')}</p>
          ) : health.budgets.checks.length === 0 ? (
            <p className="text-om-sm text-om-secondary">{t('platform.budgets.none')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass} aria-label={t('platform.budgets.title')}>
                <thead className={theadClass}>
                  <tr>
                    <th scope="col" className={thClass}>{t('platform.budgets.col.measurement')}</th>
                    <th scope="col" className={thClass}>{t('platform.budgets.col.value')}</th>
                    <th scope="col" className={thClass}>{t('platform.budgets.col.budget')}</th>
                    <th scope="col" className={thClass}>{t('platform.budgets.col.status')}</th>
                    <th scope="col" className={thClass}>{t('platform.budgets.col.measured')}</th>
                  </tr>
                </thead>
                <tbody>
                  {health.budgets.checks.map((c) => (
                    <tr
                      key={c.result + c.measure + (c.page ?? '')}
                      className={rowClass}
                      data-result={c.result}
                      data-within={String(c.withinBudget)}
                    >
                      <td className={tdClass + ' text-om-primary'}>
                        {t(`platform.budgets.measure.${c.measure}`)}
                        <span className="block font-om-mono text-om-2xs text-om-muted">
                          <bdi>{c.page === null ? c.result : c.result + ' · ' + c.page}</bdi>
                        </span>
                      </td>
                      <td className={tdClass + ' font-om-mono'}>{budgetValue(t, format, c, c.value)}</td>
                      <td className={tdClass + ' font-om-mono text-om-secondary'}>
                        {t(c.comparison === 'max' ? 'platform.slis.atMost' : 'platform.budgets.atLeast', {
                          value: budgetValue(t, format, c, c.budget),
                        })}
                      </td>
                      <td className={tdClass}>
                        <Tag variant="state" state={c.withinBudget ? 'healthy' : 'down'}>
                          {t(c.withinBudget ? 'platform.budgets.within' : 'platform.budgets.over')}
                        </Tag>
                      </td>
                      <td className={tdClass + ' whitespace-nowrap text-om-secondary'}>
                        {dash(c.measuredAt === null ? null : format.dateTime(c.measuredAt))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {health.budgets.invalid.length === 0 ? null : (
            <ul className="flex flex-col gap-om-4" aria-label={t('platform.budgets.invalid')}>
              {health.budgets.invalid.map((line) => (
                <li key={line} className="font-om-mono text-om-2xs text-om-rose">
                  <bdi>{line}</bdi>
                </li>
              ))}
            </ul>
          )}
          <p className="text-om-2xs text-om-muted">{t('platform.budgets.howto')}</p>
        </Card>
      </section>
    </>
  );
}

/** The data panel: reads `platformHealth` for the window and renders it (administrators only; the view gates it). */
export function PlatformHealthPanel(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const [windowMinutes, setWindowMinutes] = useState<PlatformWindowMinutes>(PLATFORM_HEALTH.windowsMinutes[0]);
  const health = useQuery(platformHealthQuery(windowMinutes));
  const options = PLATFORM_HEALTH.windowsMinutes.map((m) => ({ value: String(m), label: t(`platform.window.${String(m) as `${PlatformWindowMinutes}`}`) }));
  return (
    <>
      <div className="flex flex-wrap items-center gap-om-12">
        <Segmented
          label={t('platform.window.label')}
          options={options}
          value={String(windowMinutes)}
          onChange={(v) => {
            const next = PLATFORM_HEALTH.windowsMinutes.find((m) => String(m) === v);
            if (next !== undefined) setWindowMinutes(next);
          }}
        />
        {health.data === undefined ? null : (
          <span className="text-om-2xs text-om-muted" data-testid="platform-observed">
            {t('platform.observed', {
              at: format.dateTime(health.data.observedAt),
              version: health.data.prometheus.version ?? t('platform.noData'),
            })}
          </span>
        )}
      </div>
      {health.isPending ? <QueryState status="pending" /> : null}
      {health.isError ? <QueryState status="error" onRetry={() => void health.refetch()} /> : null}
      {health.data === undefined ? null : <Panel health={health.data} windowMinutes={windowMinutes} />}
    </>
  );
}

export function PlatformHealthView(): ReactNode {
  const t = useT();
  const can = useCan();
  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('platform.subtitle')}>
        {t('platform.title')}
      </SectionTitle>
      {can(ROLES.admin) ? <PlatformHealthPanel /> : <p className="text-om-sm text-om-secondary">{t('platform.adminOnly')}</p>}
    </div>
  );
}
