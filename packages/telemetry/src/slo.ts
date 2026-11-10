// REQ-PERF-005 (ADR-071) — the platform's service level indicators, one catalogue for two readers: the API evaluates
// each `expr` over the Prometheus HTTP API for the Platform health screen, and `renderAlertRules` turns the same entries
// into the Prometheus rule file (deploy/compose/prometheus/rules/openmap-slo.rules.yml, written by `pnpm --filter
// @openmap/telemetry slo:rules` and checked against this file by its unit test), so the screen and the alerts cannot
// disagree about what is healthy. Objectives come from PLATFORM_HEALTH, PERF_BUDGETS and BACKUP in @openmap/constants.
import { BACKUP, PERF_BUDGETS, PLATFORM_HEALTH, TIME } from '@openmap/constants';

export const PLATFORM_SLI_IDS = [
  'targets_down',
  'stores_down',
  'openbao_sealed',
  'graphql_p95_seconds',
  'graphql_error_ratio',
  'http_error_ratio',
  'event_loop_lag_p99_seconds',
  'outbox_oldest_pending_seconds',
  'queue_waiting_jobs',
  'backup_age_seconds',
] as const;
export type PlatformSliId = (typeof PLATFORM_SLI_IDS)[number];

export type PlatformSliUnit = 'count' | 'seconds' | 'ratio';
export type AlertSeverity = 'critical' | 'warning';

export interface PlatformSliDefinition {
  id: PlatformSliId;
  unit: PlatformSliUnit;
  /** The indicator may not exceed this; every OpenMap SLO is an upper bound. */
  objective: number;
  /** The indicator as one number over the window (an empty result or NaN means there was nothing to measure). */
  expr: (window: string) => string;
  alert: {
    name: string;
    severity: AlertSeverity;
    forMinutes: number;
    /** The alert condition; it may keep labels (instance, store, queue) so each firing alert names what broke. */
    expr: (window: string) => string;
    /** Operator-facing one-liner for Alertmanager; the console names alerts through its own i18n keys. */
    summary: string;
  };
}

const J = PLATFORM_HEALTH.jobs;
const M = PLATFORM_HEALTH.metrics;
const Q = String(PLATFORM_HEALTH.quantile);
const SCRAPED = [J.services, J.collector, J.clickhouse].join('|');
const HTTP_COUNT = 'openmap_http_server_request_duration_seconds_count';
const SERVER_ERROR = 'http_response_status_code=~"5.."';

/** A PromQL range for a window in minutes. */
export function promWindow(minutes: number): string {
  return String(minutes) + 'm';
}

const over = (expr: string, objective: number): string => '(' + expr + ') > ' + String(objective);

const graphqlP95 = (w: string): string =>
  'histogram_quantile(' + Q + ', sum by (le) (rate(openmap_graphql_duration_seconds_bucket[' + w + '])))';
const graphqlErrors = (w: string): string =>
  '(sum(rate(openmap_graphql_requests_total{status="error"}[' + w + '])) or vector(0)) / sum(rate(openmap_graphql_requests_total[' + w + ']))';
const httpErrors = (w: string): string =>
  '(sum(rate(' + HTTP_COUNT + '{' + SERVER_ERROR + '}[' + w + '])) or vector(0)) / sum(rate(' + HTTP_COUNT + '[' + w + ']))';
const openbaoSealed = '(1 - min(vault_core_unsealed{job="' + J.openbao + '"})) or (1 - max(up{job="' + J.openbao + '"}))';
const avail = PLATFORM_HEALTH.alertForMinutes.availability;
const sustained = PLATFORM_HEALTH.alertForMinutes.budget;

export const PLATFORM_SLIS: readonly PlatformSliDefinition[] = [
  {
    id: 'targets_down',
    unit: 'count',
    objective: 0,
    // `or 0 * count(...)`: zero when every series is up, and no data (not a false zero) when the series is absent.
    expr: () => 'count(up{job=~"' + SCRAPED + '"} == 0) or (0 * count(up{job=~"' + SCRAPED + '"}))',
    alert: {
      name: 'OpenMapTargetDown',
      severity: 'critical',
      forMinutes: avail,
      expr: () => 'up{job=~"' + SCRAPED + '"} == 0',
      summary: 'An OpenMap service or store stopped answering its Prometheus scrape: {{ $labels.instance }}',
    },
  },
  {
    id: 'stores_down',
    unit: 'count',
    objective: 0,
    expr: () => 'count(max by (store) (' + M.storeUp + ') == 0) or (0 * count(' + M.storeUp + '))',
    alert: {
      name: 'OpenMapStoreDown',
      severity: 'critical',
      forMinutes: avail,
      expr: () => 'max by (store) (' + M.storeUp + ') == 0',
      summary: 'The reconciler cannot reach the {{ $labels.store }} store',
    },
  },
  {
    id: 'openbao_sealed',
    unit: 'count',
    objective: 0,
    expr: () => openbaoSealed,
    alert: {
      name: 'OpenMapOpenBaoSealed',
      severity: 'critical',
      forMinutes: avail,
      expr: () => over(openbaoSealed, 0),
      summary: 'OpenBao is sealed or not answering: secrets, field decryption and backups wait for an unseal',
    },
  },
  {
    id: 'graphql_p95_seconds',
    unit: 'seconds',
    objective: PERF_BUDGETS.screenInteractionP95Ms / TIME.msPerSecond,
    expr: graphqlP95,
    alert: {
      name: 'OpenMapGraphqlLatencyOverBudget',
      severity: 'warning',
      forMinutes: sustained,
      expr: (w) => over(graphqlP95(w), PERF_BUDGETS.screenInteractionP95Ms / TIME.msPerSecond),
      summary: 'GraphQL p95 is over the screen interaction budget',
    },
  },
  {
    id: 'graphql_error_ratio',
    unit: 'ratio',
    objective: PLATFORM_HEALTH.errorRatioMax,
    expr: graphqlErrors,
    alert: {
      name: 'OpenMapGraphqlErrors',
      severity: 'warning',
      forMinutes: sustained,
      expr: (w) => over(graphqlErrors(w), PLATFORM_HEALTH.errorRatioMax),
      summary: 'More GraphQL operations fail than the error objective allows',
    },
  },
  {
    id: 'http_error_ratio',
    unit: 'ratio',
    objective: PLATFORM_HEALTH.errorRatioMax,
    expr: httpErrors,
    alert: {
      name: 'OpenMapHttpServerErrors',
      severity: 'warning',
      forMinutes: sustained,
      expr: (w) =>
        '(sum by (exported_job) (rate(' + HTTP_COUNT + '{' + SERVER_ERROR + '}[' + w + '])) / sum by (exported_job) (rate(' +
        HTTP_COUNT + '[' + w + ']))) > ' + String(PLATFORM_HEALTH.errorRatioMax),
      summary: '{{ $labels.exported_job }} answers more 5xx responses than the error objective allows',
    },
  },
  {
    id: 'event_loop_lag_p99_seconds',
    unit: 'seconds',
    objective: PLATFORM_HEALTH.eventLoopLagP99MaxSeconds,
    expr: () => 'max(nodejs_eventloop_lag_p99_seconds{job="' + J.services + '"})',
    alert: {
      name: 'OpenMapEventLoopLag',
      severity: 'warning',
      forMinutes: sustained,
      expr: () =>
        'max by (instance) (nodejs_eventloop_lag_p99_seconds{job="' + J.services + '"}) > ' +
        String(PLATFORM_HEALTH.eventLoopLagP99MaxSeconds),
      summary: 'The event loop of {{ $labels.instance }} is blocked long enough to delay every request',
    },
  },
  {
    id: 'outbox_oldest_pending_seconds',
    unit: 'seconds',
    objective: PLATFORM_HEALTH.outboxAgeMaxSeconds,
    expr: () => 'max(' + M.outboxOldest + ')',
    alert: {
      name: 'OpenMapOutboxBacklog',
      severity: 'warning',
      forMinutes: avail,
      expr: () => over('max(' + M.outboxOldest + ')', PLATFORM_HEALTH.outboxAgeMaxSeconds),
      summary: 'Outbox rows wait to reach the graph, search and analytics stores',
    },
  },
  {
    id: 'queue_waiting_jobs',
    unit: 'count',
    objective: PLATFORM_HEALTH.queueWaitingMax,
    expr: () => 'max(' + M.queueJobs + '{state="waiting"})',
    alert: {
      name: 'OpenMapQueueBacklog',
      severity: 'warning',
      forMinutes: sustained,
      expr: () => 'max by (queue) (' + M.queueJobs + '{state="waiting"}) > ' + String(PLATFORM_HEALTH.queueWaitingMax),
      summary: 'Jobs pile up in the {{ $labels.queue }} queue',
    },
  },
  {
    id: 'backup_age_seconds',
    unit: 'seconds',
    objective: BACKUP.staleHours * (TIME.msPerHour / TIME.msPerSecond),
    expr: () => 'time() - max(openmap_backup_last_complete_timestamp_seconds)',
    alert: {
      name: 'OpenMapBackupStale',
      severity: 'warning',
      forMinutes: avail,
      expr: () =>
        over('time() - max(openmap_backup_last_complete_timestamp_seconds)', BACKUP.staleHours * (TIME.msPerHour / TIME.msPerSecond)),
      summary: 'No complete backup of the stores of record within the freshness window',
    },
  },
];

/** The alert rule file Prometheus loads (YAML; every string double-quoted through JSON so PromQL quotes survive). */
export function renderAlertRules(header: readonly string[]): string {
  const q = (s: string): string => JSON.stringify(s);
  const window = promWindow(PLATFORM_HEALTH.windowsMinutes[0]);
  const out: string[] = [...header.map((l) => '# ' + l), 'groups:', '  - name: ' + q(PLATFORM_HEALTH.ruleGroup), '    rules:'];
  for (const s of PLATFORM_SLIS) {
    out.push(
      '      - alert: ' + q(s.alert.name),
      '        expr: ' + q(s.alert.expr(window)),
      '        for: ' + q(promWindow(s.alert.forMinutes)),
      '        labels:',
      '          severity: ' + q(s.alert.severity),
      '          ' + PLATFORM_HEALTH.sliLabel + ': ' + q(s.id),
      '        annotations:',
      '          summary: ' + q(s.alert.summary),
    );
  }
  return out.join('\n') + '\n';
}

/** The header the committed rule file carries. */
export const ALERT_RULES_HEADER = [
  'REQ-PERF-005 (ADR-071) — OpenMap SLO alert rules, generated from packages/telemetry/src/slo.ts by',
  '`pnpm --filter @openmap/telemetry slo:rules`. Do not edit by hand: the unit test fails when this file and the catalogue differ.',
] as const;
