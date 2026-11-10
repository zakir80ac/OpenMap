'use client';
// REQ-INT-012 (ADR-073) — Monitoring events: the alerts Prometheus Alertmanager, Zabbix, Nagios / Icinga, Datadog,
// SolarWinds and Splunk sent, firing first, each with its severity, what it does to its CI's health, the CI it was
// matched to (and how) or "no CI found", what it named the affected thing by, and when it started, ended and was last
// received. Operators map an unresolved source to a CI (search, pick) and clear an alert its sender will never
// resolve; everyone sees the address each monitoring integration receives events at and the mapped sources.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { CONSOLE, ROLES } from '@openmap/constants';
import { MONITORING_SEVERITIES, MONITORING_TARGET_KINDS, MONITORING_VENDORS, type MonitoringSeverity, type MonitoringTargetKind, type MonitoringVendor } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { Card, Kpi, SectionTitle, Segmented, Tag, type UiState } from '@openmap/ui';
import { useId, useState, type ReactNode } from 'react';
import { Button, Field, Select, TextInput, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { QueryState } from '@/components/common/QueryState';
import { useCan } from '@/lib/auth';
import { integrationsQuery } from '@/lib/estate-queries';
import { localizedHref } from '@/lib/locale-path';
import {
  clearMonitoringAlert,
  ingestAddress,
  mapMonitoringSource,
  mappableKeys,
  monitoringAlertsQuery,
  monitoringKey,
  type MonitoringAlert,
  type MonitoringFilter,
} from '@/lib/monitoring-queries';
import { searchQuery } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import { useFormatters, useLocale, useT } from '@/providers';

const SEVERITY_KEY = {
  critical: 'monitoring.severity.critical',
  high: 'monitoring.severity.high',
  medium: 'monitoring.severity.medium',
  low: 'monitoring.severity.low',
  informational: 'monitoring.severity.informational',
} as const satisfies Record<MonitoringSeverity, MessageKey>;
const VENDOR_KEY = {
  prometheus_alertmanager: 'monitoring.vendor.prometheus_alertmanager',
  zabbix: 'monitoring.vendor.zabbix',
  nagios: 'monitoring.vendor.nagios',
  datadog: 'monitoring.vendor.datadog',
  solarwinds: 'monitoring.vendor.solarwinds',
  splunk: 'monitoring.vendor.splunk',
} as const satisfies Record<MonitoringVendor, MessageKey>;
const TARGET_KEY = {
  ci_id: 'monitoring.target.ci_id',
  fqdn: 'monitoring.target.fqdn',
  instance: 'monitoring.target.instance',
  ip: 'monitoring.target.ip',
  hostname: 'monitoring.target.hostname',
} as const satisfies Record<MonitoringTargetKind, MessageKey>;
const RESOLUTION_KEY = {
  ci_id: 'monitoring.resolution.ci_id',
  mapping: 'monitoring.resolution.mapping',
  identity: 'monitoring.resolution.identity',
} as const satisfies Record<NonNullable<MonitoringAlert['resolution']>, MessageKey>;
const FILTERS: readonly MonitoringFilter[] = ['all', 'firing', 'unresolved'];
const FILTER_KEY = {
  all: 'monitoring.filter.all',
  firing: 'monitoring.filter.firing',
  unresolved: 'monitoring.filter.unresolved',
} as const satisfies Record<MonitoringFilter, MessageKey>;

function vendorKey(vendor: string): MessageKey | null {
  return (MONITORING_VENDORS as readonly string[]).includes(vendor) ? VENDOR_KEY[vendor as MonitoringVendor] : null;
}

/** The state tag of an alert: a firing alert shows what it does to its CI; a resolved one is healthy again. */
function stateOf(a: MonitoringAlert): UiState {
  if (a.status === 'resolved') return 'healthy';
  return a.effect ?? 'unknown';
}

export function MonitoringEventsView(): ReactNode {
  const t = useT();
  const locale = useLocale();
  const operator = useCan()(ROLES.operator);
  const [filter, setFilter] = useState<MonitoringFilter>('all');
  const alerts = useQuery(monitoringAlertsQuery(filter));
  const integrations = useQuery(integrationsQuery('monitoring'));
  const format = useFormatters();

  return (
    <div className="flex flex-col gap-om-16">
      <SectionTitle
        as="h1"
        size="lg"
        eyebrow={
          <Link href={localizedHref(locale, '/integrations')} className="text-om-cyan hover:underline">
            {t('monitoring.back')}
          </Link>
        }
        description={t('monitoring.subtitle')}
      >
        {t('monitoring.title')}
      </SectionTitle>

      <Card padding="24" className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm" description={t('monitoring.endpoints.subtitle')}>
          {t('monitoring.endpoints.title')}
        </SectionTitle>
        {integrations.isPending ? (
          <QueryState status="pending" />
        ) : integrations.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void integrations.refetch();
            }}
          />
        ) : integrations.data.length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('monitoring.endpoints.empty')}</p>
        ) : (
          <table className={tableClass} aria-label={t('monitoring.endpoints.title')}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>{t('integrations.table.name')}</th>
                <th className={thClass}>{t('integrations.table.vendor')}</th>
                <th className={thClass}>{t('monitoring.endpoints.address')}</th>
              </tr>
            </thead>
            <tbody>
              {integrations.data.map((i) => {
                const key = vendorKey(i.vendor);
                return (
                  <tr key={i.id} className={rowClass}>
                    <td className={tdClass + ' text-om-primary'}>{i.name}</td>
                    <td className={tdClass + ' text-om-secondary'}>{key === null ? i.vendor : t(key)}</td>
                    <td className={tdClass}>
                      <code dir="ltr" className="break-all font-om-mono text-om-2xs text-om-secondary">
                        {ingestAddress(i.id)}
                      </code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {alerts.isPending ? (
        <QueryState status="pending" />
      ) : alerts.isError ? (
        <QueryState
          status="error"
          onRetry={() => {
            void alerts.refetch();
          }}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-om-12 md:grid-cols-3" role="group" aria-label={t('monitoring.summary')}>
            <Kpi label={t('monitoring.kpi.firing')} value={format.integer(alerts.data.firing)} />
            <Kpi label={t('monitoring.kpi.unresolved')} value={format.integer(alerts.data.unresolved)} />
            <Kpi label={t('monitoring.kpi.mappings')} value={format.integer(alerts.data.mappings.length)} />
          </div>
          <Segmented
            label={t('monitoring.filter.label')}
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((f) => ({ value: f, label: t(FILTER_KEY[f]) }))}
          />
          {alerts.data.alerts.length === 0 ? (
            <Card>
              <p className="text-om-sm text-om-secondary">{t('monitoring.empty')}</p>
            </Card>
          ) : (
            <ul className="flex flex-col gap-om-8" aria-label={t('monitoring.list')}>
              {alerts.data.alerts.map((a) => (
                <AlertItem key={a.id} alert={a} operator={operator} />
              ))}
            </ul>
          )}
          <MappingsCard mappings={alerts.data.mappings} />
        </>
      )}
    </div>
  );
}

function AlertItem({ alert: a, operator }: { alert: MonitoringAlert; operator: boolean }): ReactNode {
  const t = useT();
  const locale = useLocale();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const [mapping, setMapping] = useState(false);
  const clear = useMutation({
    mutationFn: () => clearMonitoringAlert(a.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: monitoringKey }),
  });
  const vendor = vendorKey(a.vendor);
  const severity = (MONITORING_SEVERITIES as readonly string[]).includes(a.severity) ? t(SEVERITY_KEY[a.severity]) : a.severity;
  return (
    <li aria-label={a.title}>
      <Card className="flex flex-col gap-om-6">
        <div className="flex flex-wrap items-center gap-om-8">
          <Tag variant="state" state={stateOf(a)}>
            {a.status === 'firing' ? t('monitoring.status.firing') : t('monitoring.status.resolved')}
          </Tag>
          <span className="text-om-2xs font-semibold uppercase tracking-wide text-om-muted">{severity}</span>
          <span dir="auto" className="font-medium text-om-primary">
            {a.title}
          </span>
          <span className="ms-auto text-om-2xs text-om-muted">
            {a.status === 'firing' ? t('monitoring.since', { when: format.dateTime(a.startsAt) }) : t('monitoring.endedAt', { when: format.dateTime(a.endsAt ?? a.lastReceivedAt) })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-om-12 gap-y-om-4 text-om-xs">
          <span className="text-om-secondary">{(vendor === null ? a.vendor : t(vendor)) + ' · ' + a.integrationName}</span>
          {a.ci !== null ? (
            <span className="flex items-center gap-om-4">
              <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(a.ci.id))} className="text-om-cyan hover:underline">
                {a.ci.displayName}
              </Link>
              {a.resolution !== null ? <span className="text-om-2xs text-om-muted">{t(RESOLUTION_KEY[a.resolution])}</span> : null}
            </span>
          ) : (
            <Tag variant="state" state="at_risk">
              {t('monitoring.unresolved')}
            </Tag>
          )}
          <span className="text-om-2xs text-om-muted">
            {a.status === 'firing' ? (a.effect === 'down' ? t('monitoring.effect.down') : a.effect === 'degraded' ? t('monitoring.effect.degraded') : t('monitoring.effect.none')) : null}
          </span>
        </div>
        {a.description !== null ? (
          <p dir="auto" className="text-om-xs text-om-secondary">
            {a.description}
          </p>
        ) : null}
        <dl className="flex flex-wrap gap-x-om-12 gap-y-om-4 text-om-xs" aria-label={t('monitoring.targets')}>
          {a.targets.map((target) => (
            <div key={target.kind + target.value} className="flex gap-om-4">
              <dt className="text-om-muted">{(MONITORING_TARGET_KINDS as readonly string[]).includes(target.kind) ? t(TARGET_KEY[target.kind]) : target.kind}</dt>
              <dd dir="ltr" className="font-om-mono text-om-primary">
                {target.value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-om-8 text-om-2xs text-om-muted">
          <span>{t('monitoring.received', { count: format.integer(a.receivedCount), when: format.dateTime(a.lastReceivedAt) })}</span>
          {a.status === 'firing' && a.expiresAt !== null ? <span>{t('monitoring.expires', { when: format.dateTime(a.expiresAt) })}</span> : null}
          {a.sourceUrl !== null && a.sourceUrl !== '' ? (
            <a href={a.sourceUrl} target="_blank" rel="noreferrer" className="text-om-cyan hover:underline">
              {t('monitoring.source')}
            </a>
          ) : null}
          {operator ? (
            <span className="ms-auto flex gap-om-6">
              {a.ci === null && mappableKeys(a.targets).length > 0 && !mapping ? (
                <Button
                  tone="quiet"
                  onClick={() => {
                    setMapping(true);
                  }}
                >
                  {t('monitoring.map')}
                </Button>
              ) : null}
              {a.status === 'firing' ? (
                <Button
                  tone="quiet"
                  disabled={clear.isPending}
                  onClick={() => {
                    clear.mutate();
                  }}
                >
                  {t('monitoring.clear')}
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
        {clear.isError ? (
          <p role="alert" className="text-om-xs text-om-state-down">
            {t('monitoring.clear.failed')}
          </p>
        ) : null}
        {mapping ? (
          <MapForm
            alert={a}
            onDone={() => {
              setMapping(false);
            }}
          />
        ) : null}
      </Card>
    </li>
  );
}

function MapForm({ alert: a, onDone }: { alert: MonitoringAlert; onDone: () => void }): ReactNode {
  const t = useT();
  const queryClient = useQueryClient();
  const keyId = useId();
  const searchId = useId();
  const keys = mappableKeys(a.targets);
  const [sourceKey, setSourceKey] = useState(keys[0]?.value ?? '');
  const [text, setText] = useState(keys[0]?.value ?? '');
  const debounced = useDebounced(text, CONSOLE.searchDebounceMs);
  const results = useQuery(searchQuery({ text: debounced }));
  const map = useMutation({
    mutationFn: (ciId: string) => mapMonitoringSource(sourceKey, ciId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: monitoringKey });
      onDone();
    },
  });
  return (
    <form
      className="flex flex-col gap-om-8 rounded-om-panel border border-om-border-glass bg-om-surface2/60 p-om-12"
      aria-label={t('monitoring.map')}
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <div className="grid gap-om-8 md:grid-cols-2">
        <Field id={keyId} label={t('monitoring.map.key')}>
          <Select
            id={keyId}
            value={sourceKey}
            onChange={(e) => {
              setSourceKey(e.target.value);
            }}
          >
            {keys.map((k) => (
              <option key={k.kind + k.value} value={k.value}>
                {t(TARGET_KEY[k.kind]) + ': ' + k.value}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={searchId} label={t('monitoring.map.search')}>
          <TextInput
            id={searchId}
            type="search"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        </Field>
      </div>
      <ul className="flex flex-col gap-om-4" aria-label={t('monitoring.map.results')}>
        {(results.data ?? []).map((hit) => (
          <li key={hit.ci.id}>
            <Button
              tone="quiet"
              disabled={map.isPending}
              onClick={() => {
                map.mutate(hit.ci.id);
              }}
            >
              {t('monitoring.map.to', { name: hit.ci.displayName })}
            </Button>
          </li>
        ))}
      </ul>
      {results.isSuccess && results.data.length === 0 ? <p className="text-om-xs text-om-muted">{t('monitoring.map.none')}</p> : null}
      <div className="flex gap-om-8">
        <Button tone="quiet" onClick={onDone}>
          {t('monitoring.map.cancel')}
        </Button>
      </div>
      {map.isError ? (
        <p role="alert" className="text-om-xs text-om-state-down">
          {t('monitoring.map.failed')}
        </p>
      ) : null}
    </form>
  );
}

function MappingsCard({ mappings }: { mappings: ReadonlyArray<{ id: string; sourceKey: string; ci: { id: string; displayName: string } | null; createdBy: string; createdAt: string }> }): ReactNode {
  const t = useT();
  const locale = useLocale();
  const format = useFormatters();
  return (
    <Card padding="24" className="flex flex-col gap-om-12">
      <SectionTitle as="h2" size="sm" description={t('monitoring.mappings.subtitle')}>
        {t('monitoring.mappings.title')}
      </SectionTitle>
      {mappings.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('monitoring.mappings.empty')}</p>
      ) : (
        <table className={tableClass} aria-label={t('monitoring.mappings.title')}>
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>{t('monitoring.mappings.source')}</th>
              <th className={thClass}>{t('monitoring.mappings.ci')}</th>
              <th className={thClass}>{t('monitoring.mappings.by')}</th>
              <th className={thClass}>{t('monitoring.mappings.when')}</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.id} className={rowClass}>
                <td dir="ltr" className={tdClass + ' font-om-mono text-om-primary'}>
                  {m.sourceKey}
                </td>
                <td className={tdClass}>
                  {m.ci === null ? null : (
                    <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(m.ci.id))} className="text-om-cyan hover:underline">
                      {m.ci.displayName}
                    </Link>
                  )}
                </td>
                <td className={tdClass + ' text-om-secondary'}>{m.createdBy}</td>
                <td className={tdClass + ' text-om-secondary'}>{format.dateTime(m.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
