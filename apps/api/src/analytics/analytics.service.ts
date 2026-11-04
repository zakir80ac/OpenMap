// REQ-UI-017 — embedded Superset analytics (ADR-012). On first use the service provisions the estate dashboard
// through Superset's REST API — ClickHouse database, datasets, charts, dashboard, embedding, guest-role permissions —
// idempotently by name, then mints a short-lived guest token whose row-level-security clause pins tenant_id so the
// browser only ever sees its tenant's rows. Superset credentials come from the environment; nothing is stored.
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ANALYTICS } from '@openmap/constants';
import type { Env } from '@openmap/config';
import { ENV } from '../config/env.module.js';
import { MetricsService } from '../metrics/metrics.service.js';

export interface AnalyticsEmbedView {
  supersetUrl: string;
  dashboardId: string;
  token: string;
  expiresInSeconds: number;
}

interface Session {
  accessToken: string;
  csrfToken: string;
  cookie: string;
}

interface ChartSpec {
  name: string;
  dataset: string;
  vizType: string;
  params: Record<string, unknown>;
  width: number;
}

interface DatasetSpec {
  name: string;
  /** Physical table name, or null for a virtual (SQL) dataset. */
  table: string | null;
  sql: string | null;
}

const UNFILTERED_TIME_RANGE = 'No filter';

const sqlMetric = (expression: string, label: string): Record<string, unknown> => ({ expressionType: 'SQL', sqlExpression: expression, label, hasCustomLabel: true, aggregate: null, column: null, optionName: 'metric_' + label.toLowerCase().replace(/\W+/g, '_') });
const timeFilter = (column: string): Record<string, unknown> => ({ clause: 'WHERE', expressionType: 'SIMPLE', subject: column, operator: 'TEMPORAL_RANGE', comparator: UNFILTERED_TIME_RANGE, filterOptionName: 'filter_' + column });

/** Datasets over the ClickHouse analytics tables (packages/db/clickhouse/0001_init.sql). Every one carries tenant_id. */
export function datasetSpecs(database: string): DatasetSpec[] {
  return [
    { name: 'openmap_layer_counts', table: null, sql: 'SELECT tenant_id, day, layer, uniqMerge(cis) AS cis FROM ' + database + '.layer_counts_daily GROUP BY tenant_id, day, layer' },
    { name: 'discovery_runs', table: 'discovery_runs', sql: null },
    { name: 'service_health_history', table: 'service_health_history', sql: null },
    { name: 'audit_log', table: 'audit_log', sql: null },
    { name: 'events', table: 'events', sql: null },
  ];
}

/** The estate dashboard's charts, left to right, row by row (widths sum to the grid per row). */
export function chartSpecs(): ChartSpec[] {
  const half = ANALYTICS.gridColumns / ANALYTICS.chartsPerWideRow;
  const third = ANALYTICS.gridColumns / ANALYTICS.chartsPerNarrowRow;
  return [
    { name: 'CIs by layer over time', dataset: 'openmap_layer_counts', vizType: 'echarts_timeseries_bar', width: half, params: { x_axis: 'day', time_grain_sqla: 'P1D', metrics: [sqlMetric('SUM(cis)', 'CIs')], groupby: ['layer'], adhoc_filters: [timeFilter('day')], stack: 'Stack', show_legend: true, legendOrientation: 'top', x_axis_time_format: 'smart_date', y_axis_format: 'SMART_NUMBER', color_scheme: ANALYTICS.colorScheme, row_limit: ANALYTICS.chartRowLimit } },
    { name: 'Discovery runs by outcome', dataset: 'discovery_runs', vizType: 'echarts_timeseries_bar', width: half, params: { x_axis: 'started_at', time_grain_sqla: 'P1D', metrics: [sqlMetric('COUNT(*)', 'Runs')], groupby: ['status'], adhoc_filters: [timeFilter('started_at')], stack: 'Stack', show_legend: true, legendOrientation: 'top', x_axis_time_format: 'smart_date', color_scheme: ANALYTICS.colorScheme, row_limit: ANALYTICS.chartRowLimit } },
    { name: 'Service health states', dataset: 'service_health_history', vizType: 'echarts_timeseries_line', width: third, params: { x_axis: 'ts', time_grain_sqla: 'PT1H', metrics: [sqlMetric('COUNT(*)', 'Services')], groupby: ['health'], adhoc_filters: [timeFilter('ts')], show_legend: true, legendOrientation: 'top', x_axis_time_format: 'smart_date', color_scheme: ANALYTICS.colorScheme, row_limit: ANALYTICS.chartRowLimit } },
    { name: 'Audit actions', dataset: 'audit_log', vizType: 'pie', width: third, params: { metric: sqlMetric('COUNT(*)', 'Entries'), groupby: ['action'], adhoc_filters: [timeFilter('at')], show_labels: true, label_type: 'key_value', donut: true, color_scheme: ANALYTICS.colorScheme, row_limit: ANALYTICS.chartRowLimit } },
    { name: 'Events by type', dataset: 'events', vizType: 'echarts_timeseries_bar', width: third, params: { x_axis: 'time', time_grain_sqla: 'PT1H', metrics: [sqlMetric('COUNT(*)', 'Events')], groupby: ['type'], adhoc_filters: [timeFilter('time')], stack: 'Stack', show_legend: false, x_axis_time_format: 'smart_date', color_scheme: ANALYTICS.colorScheme, row_limit: ANALYTICS.chartRowLimit } },
  ];
}

/** Superset v2 dashboard layout: one ROW per group of charts whose widths fill the grid. */
export function positionJson(charts: ReadonlyArray<{ id: number; name: string; width: number }>): Record<string, unknown> {
  const layout: Record<string, unknown> = {
    DASHBOARD_VERSION_KEY: 'v2',
    ROOT_ID: { type: 'ROOT', id: 'ROOT_ID', children: ['GRID_ID'] },
    GRID_ID: { type: 'GRID', id: 'GRID_ID', children: [] as string[], parents: ['ROOT_ID'] },
  };
  const rows: string[] = [];
  let rowIndex = 0;
  let used = 0;
  let currentRow = '';
  for (const chart of charts) {
    if (currentRow === '' || used + chart.width > ANALYTICS.gridColumns) {
      rowIndex += 1;
      currentRow = 'ROW-' + String(rowIndex);
      rows.push(currentRow);
      layout[currentRow] = { type: 'ROW', id: currentRow, children: [] as string[], parents: ['ROOT_ID', 'GRID_ID'], meta: { background: 'BACKGROUND_TRANSPARENT' } };
      used = 0;
    }
    const chartKey = 'CHART-' + String(chart.id);
    (layout[currentRow] as { children: string[] }).children.push(chartKey);
    layout[chartKey] = { type: 'CHART', id: chartKey, children: [], parents: ['ROOT_ID', 'GRID_ID', currentRow], meta: { chartId: chart.id, width: chart.width, height: ANALYTICS.chartHeight, sliceName: chart.name } };
    used += chart.width;
  }
  (layout['GRID_ID'] as { children: string[] }).children = rows;
  return layout;
}

/**
 * The Horizon surfaces inside the embedded dashboard (REQ-UI-031, ADR-020): the dashboard's own CSS, applied by
 * Superset to the grid, the chart cards, legends, axes and tooltips. Colours mirror packages/ui tokens (ground,
 * surfaces, text); charts take their series colours from ANALYTICS.colorScheme.
 */
export function dashboardCss(): string {
  const { ground, surface, border, text, muted, accent } = ANALYTICS.theme;
  return [
    'body, .dashboard, .dashboard-content, .grid-container, .dashboard-component-tabs, .dashboard-header { background: ' + ground + ' !important; color: ' + text + ' !important; }',
    '.dashboard-component-chart-holder, .chart-container, .dashboard-component-chart-holder .chart-container { background: ' + surface + ' !important; border: 1px solid ' + border + ' !important; border-radius: ' + String(ANALYTICS.theme.cardRadiusPx) + 'px !important; box-shadow: ' + ANALYTICS.theme.cardShadow + ' !important; }',
    '.dashboard-component-chart-holder .header-title a, .dashboard-component-chart-holder .header-title, .editable-title, .header-controls, .dashboard-header .editable-title input { color: ' + text + ' !important; font-family: ' + ANALYTICS.theme.fontFamily + ' !important; }',
    '.dashboard-component-header, .dashboard-header, .dashboard-component-tabs .nav-tabs { background: transparent !important; border-color: ' + border + ' !important; }',
    '.dashboard-filters-panel, .dashboard-filter-bar, .filter-bar, .ant-collapse, .ant-collapse-content, .ant-collapse-item, .ant-select-selector, .ant-input { background: ' + surface + ' !important; color: ' + text + ' !important; border-color: ' + border + ' !important; }',
    '.dashboard-component-chart-holder .slice_container, .dashboard-component-chart-holder .chart-container { color: ' + text + ' !important; }',
    '.echarts-for-react text, .echarts-for-react tspan { fill: ' + muted + ' !important; }',
    'svg .axis text, svg .legend text, svg .tick text, .nvtooltip, .chart-tooltip { fill: ' + muted + ' !important; color: ' + text + ' !important; }',
    '.ant-tooltip-inner, .echarts-tooltip, div[style*="background-color: rgb(255, 255, 255)"] { background: ' + surface + ' !important; color: ' + text + ' !important; border: 1px solid ' + border + ' !important; }',
    '.dashboard-component-chart-holder:hover { border-color: ' + ANALYTICS.theme.hoverBorder + ' !important; }',
    'a, .ant-btn-link { color: ' + accent + ' !important; }',
    '.ant-table, .ant-table-thead > tr > th, .ant-table-tbody > tr > td, .table > thead > tr > th, .table > tbody > tr > td { background: transparent !important; color: ' + text + ' !important; border-color: ' + border + ' !important; }',
    '.grid-row.background--white, .dashboard-component.dashboard-component-row, .dashboard-component-row { background: transparent !important; }',
    '.resize-drag-handle, .dragdroppable { border-color: ' + border + ' !important; }',
  ].join('\n');
}

/** ClickHouse SQLAlchemy URI for Superset, from the API's own ClickHouse settings (same host the API reaches). */
export function clickhouseUri(env: Pick<Env, 'CLICKHOUSE_URL' | 'CLICKHOUSE_USER' | 'CLICKHOUSE_PASSWORD' | 'CLICKHOUSE_DB'>): string {
  const url = new URL(env.CLICKHOUSE_URL);
  const secure = url.protocol === 'https:';
  return 'clickhousedb://' + encodeURIComponent(env.CLICKHOUSE_USER) + ':' + encodeURIComponent(env.CLICKHOUSE_PASSWORD) + '@' + url.hostname + (url.port ? ':' + url.port : '') + '/' + env.CLICKHOUSE_DB + (secure ? '?protocol=https' : '');
}

function risonFilter(column: string, value: string): string {
  return 'q=(filters:!((col:' + column + ",opr:eq,value:'" + value.replace(/'/g, "!'") + "')))";
}

@Injectable()
export class AnalyticsService {
  private provisioned: Promise<string> | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly metrics: MetricsService,
  ) {}

  /** A guest token for the tenant plus everything the browser needs to embed the dashboard. */
  async embed(tenantId: string): Promise<AnalyticsEmbedView> {
    const dashboardId = await this.dashboardId();
    const session = await this.login();
    const result = await this.call<{ token: string }>(session, 'POST', '/api/v1/security/guest_token/', {
      user: { username: 'openmap-' + tenantId, first_name: ANALYTICS.guestFirstName, last_name: ANALYTICS.guestLastName },
      resources: [{ type: 'dashboard', id: dashboardId }],
      rls: [{ clause: "tenant_id = '" + tenantId + "'" }],
    });
    this.metrics.analyticsTokens.inc();
    return { supersetUrl: this.env.PUBLIC_SUPERSET_URL.replace(/\/$/, ''), dashboardId, token: result.token, expiresInSeconds: ANALYTICS.guestTokenSeconds };
  }

  /** The embedded dashboard's uuid, provisioning on first call; a failed provisioning is retried on the next call. */
  dashboardId(): Promise<string> {
    if (this.provisioned === null) {
      this.provisioned = this.provision().catch((err: unknown) => {
        this.provisioned = null;
        throw err;
      });
    }
    return this.provisioned;
  }

  private async provision(): Promise<string> {
    const session = await this.login();
    const databaseId = await this.ensureDatabase(session);
    const datasetIds = new Map<string, number>();
    for (const spec of datasetSpecs(this.env.CLICKHOUSE_DB)) datasetIds.set(spec.name, await this.ensureDataset(session, databaseId, spec));
    const dashboard = await this.ensureDashboard(session);
    const charts: Array<{ id: number; name: string; width: number }> = [];
    for (const spec of chartSpecs()) {
      const datasetId = datasetIds.get(spec.dataset);
      if (datasetId === undefined) throw new Error('chart ' + spec.name + ' references unknown dataset ' + spec.dataset);
      charts.push({ id: await this.ensureChart(session, dashboard.id, datasetId, spec), name: spec.name, width: spec.width });
    }
    await this.call(session, 'PUT', '/api/v1/dashboard/' + String(dashboard.id), { position_json: JSON.stringify(positionJson(charts)), published: true, css: dashboardCss(), json_metadata: JSON.stringify({ color_scheme: ANALYTICS.colorScheme, refresh_frequency: 0, expanded_slices: {}, label_colors: {} }) });
    await this.ensureGuestRole(session);
    return this.ensureEmbedded(session, dashboard.id);
  }

  private async login(): Promise<Session> {
    const base = this.env.SUPERSET_URL.replace(/\/$/, '');
    let loginRes: Response;
    try {
      loginRes = await fetch(base + '/api/v1/security/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: this.env.SUPERSET_ADMIN_USER, password: this.env.SUPERSET_ADMIN_PASSWORD, provider: 'db', refresh: true }), signal: AbortSignal.timeout(ANALYTICS.requestTimeoutMs) });
    } catch (err) {
      throw new ServiceUnavailableException('Superset is not reachable at SUPERSET_URL: ' + (err instanceof Error ? err.message : String(err)));
    }
    if (!loginRes.ok) throw new ServiceUnavailableException('Superset login failed: HTTP ' + String(loginRes.status));
    const { access_token: accessToken } = (await loginRes.json()) as { access_token: string };
    // Superset keeps CSRF on for its UI; API writes need the token and the session cookie it is bound to.
    const csrfRes = await fetch(base + '/api/v1/security/csrf_token/', { headers: { authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(ANALYTICS.requestTimeoutMs) });
    if (!csrfRes.ok) throw new ServiceUnavailableException('Superset CSRF token failed: HTTP ' + String(csrfRes.status));
    const { result: csrfToken } = (await csrfRes.json()) as { result: string };
    const cookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0] ?? '').filter(Boolean).join('; ');
    return { accessToken, csrfToken, cookie };
  }

  private async call<T>(session: Session, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const base = this.env.SUPERSET_URL.replace(/\/$/, '');
    const headers: Record<string, string> = { authorization: 'Bearer ' + session.accessToken, accept: 'application/json', 'x-csrftoken': session.csrfToken, referer: base + '/' };
    if (session.cookie) headers['cookie'] = session.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(ANALYTICS.requestTimeoutMs) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(base + path, init);
    const text = await res.text();
    if (!res.ok) throw new ServiceUnavailableException('Superset ' + method + ' ' + path + ' failed: HTTP ' + String(res.status) + ' ' + text.slice(0, ANALYTICS.errorExcerptChars));
    return (text === '' ? {} : JSON.parse(text)) as T;
  }

  private async findOne(session: Session, path: string, column: string, value: string): Promise<{ id: number } | null> {
    const list = await this.call<{ result: Array<{ id: number }> }>(session, 'GET', path + '?' + risonFilter(column, value));
    return list.result[0] ?? null;
  }

  private async ensureDatabase(session: Session): Promise<number> {
    const existing = await this.findOne(session, '/api/v1/database/', 'database_name', ANALYTICS.databaseName);
    if (existing) return existing.id;
    const created = await this.call<{ id: number }>(session, 'POST', '/api/v1/database/', { database_name: ANALYTICS.databaseName, sqlalchemy_uri: clickhouseUri(this.env), expose_in_sqllab: false, allow_ctas: false, allow_cvas: false, allow_dml: false });
    return created.id;
  }

  private async ensureDataset(session: Session, databaseId: number, spec: DatasetSpec): Promise<number> {
    const existing = await this.findOne(session, '/api/v1/dataset/', 'table_name', spec.name);
    if (existing) return existing.id;
    const body: Record<string, unknown> = { database: databaseId, schema: this.env.CLICKHOUSE_DB, table_name: spec.name };
    if (spec.sql !== null) body['sql'] = spec.sql;
    const created = await this.call<{ id: number }>(session, 'POST', '/api/v1/dataset/', body);
    return created.id;
  }

  private async ensureDashboard(session: Session): Promise<{ id: number }> {
    const existing = await this.findOne(session, '/api/v1/dashboard/', 'slug', ANALYTICS.dashboardSlug);
    if (existing) return existing;
    const created = await this.call<{ id: number }>(session, 'POST', '/api/v1/dashboard/', { dashboard_title: ANALYTICS.dashboardTitle, slug: ANALYTICS.dashboardSlug, published: true });
    return { id: created.id };
  }

  private async ensureChart(session: Session, dashboardId: number, datasetId: number, spec: ChartSpec): Promise<number> {
    const params = JSON.stringify({ ...spec.params, datasource: String(datasetId) + '__table', viz_type: spec.vizType });
    const existing = await this.findOne(session, '/api/v1/chart/', 'slice_name', spec.name);
    if (existing) {
      await this.call(session, 'PUT', '/api/v1/chart/' + String(existing.id), { params, dashboards: [dashboardId], datasource_id: datasetId, datasource_type: 'table', viz_type: spec.vizType });
      return existing.id;
    }
    const created = await this.call<{ id: number }>(session, 'POST', '/api/v1/chart/', { slice_name: spec.name, viz_type: spec.vizType, datasource_id: datasetId, datasource_type: 'table', params, dashboards: [dashboardId] });
    return created.id;
  }

  /** The guest role Superset assigns embedded viewers (GUEST_ROLE_NAME) exists and carries the template role's permissions. */
  private async ensureGuestRole(session: Session): Promise<void> {
    const template = await this.findOne(session, '/api/v1/security/roles/', 'name', ANALYTICS.templateRole);
    if (!template) throw new ServiceUnavailableException('Superset role ' + ANALYTICS.templateRole + ' is missing');
    const guest = (await this.findOne(session, '/api/v1/security/roles/', 'name', ANALYTICS.guestRole)) ?? (await this.call<{ id: number }>(session, 'POST', '/api/v1/security/roles/', { name: ANALYTICS.guestRole }));
    const current = await this.call<{ result: Array<{ id: number }> }>(session, 'GET', '/api/v1/security/roles/' + String(guest.id) + '/permissions/');
    if (current.result.length > 0) return;
    const wanted = await this.call<{ result: Array<{ id: number }> }>(session, 'GET', '/api/v1/security/roles/' + String(template.id) + '/permissions/');
    await this.call(session, 'POST', '/api/v1/security/roles/' + String(guest.id) + '/permissions', { permission_view_menu_ids: wanted.result.map((p) => p.id) });
  }

  private async ensureEmbedded(session: Session, dashboardId: number): Promise<string> {
    const base = this.env.SUPERSET_URL.replace(/\/$/, '');
    const res = await fetch(base + '/api/v1/dashboard/' + String(dashboardId) + '/embedded', { headers: { authorization: 'Bearer ' + session.accessToken }, signal: AbortSignal.timeout(ANALYTICS.requestTimeoutMs) });
    if (res.ok) {
      const { result } = (await res.json()) as { result: { uuid: string } };
      return result.uuid;
    }
    const created = await this.call<{ result: { uuid: string } }>(session, 'POST', '/api/v1/dashboard/' + String(dashboardId) + '/embedded', { allowed_domains: [] });
    return created.result.uuid;
  }
}
