// REQ-UI-030 — GraphQL operations behind the dashboard (ADR-020): the user's dashboards, the estate aggregate the
// widgets read, and the create / update / delete / default mutations. Same conventions as queries.ts.
import { queryOptions } from '@tanstack/react-query';
import { DASHBOARD } from '@openmap/constants';
import type { AssetStage, DashboardPersona, DashboardWidgetInput, PLAN_STATUSES, WidgetKind, WidgetSize } from '@openmap/contracts';
import { gql } from './graphql';
import type { Money } from './estate-queries';

type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface DashboardWidget extends DashboardWidgetInput {
  id: string;
  kind: WidgetKind;
  size: WidgetSize;
}

export interface Dashboard {
  id: string;
  name: string;
  persona: DashboardPersona;
  owner: string;
  shared: boolean;
  isDefault: boolean;
  mine: boolean;
  widgets: DashboardWidget[];
  createdAt: string;
  updatedAt: string;
}

export interface DashboardInput {
  name: string;
  persona: DashboardPersona;
  shared: boolean;
  widgets: DashboardWidgetInput[];
}

export interface StageCount {
  stage: AssetStage;
  count: number;
  purchaseCost: Money[];
}

export interface EstateStats {
  assetsByStage: StageCount[];
  licences: { products: number; licensed: number; overDeployed: number; expiringSoon: number; expired: number; annualCost: Money[] };
  vulnerabilities: { total: number; critical: number; exploited: number; cisaKev: number; internetFacing: number; patchAvailable: number; affectedHosts: number };
  endOfSupport: number;
  plans: Array<{ status: PlanStatus; count: number; estimatedCost: Money[] }>;
  power: { racks: number; ratedWatts: number; currentWatts: number };
  ipam: { subnets: number; averageUtilisationPercent: number; critical: number };
  nodes: { total: number; online: number };
  integrations: { total: number; healthy: number; failedLastHour: number };
  incidentsOpen: number;
  trend: { days: string[]; cis: number[]; discoveryRuns: number[]; events: number[]; incidents: number[] };
}

const DASHBOARD_FIELDS = 'id name persona owner shared isDefault mine widgets { id kind size options } createdAt updatedAt';
const MONEY_FIELDS = '{ amount currency }';

const DASHBOARDS_QUERY = ['query Dashboards {', '  dashboards { ' + DASHBOARD_FIELDS + ' }', '}'].join('\n');

const ESTATE_STATS_QUERY = [
  'query EstateStats {',
  '  estateStats {',
  '    assetsByStage { stage count purchaseCost ' + MONEY_FIELDS + ' }',
  '    licences { products licensed overDeployed expiringSoon expired annualCost ' + MONEY_FIELDS + ' }',
  '    vulnerabilities { total critical exploited cisaKev internetFacing patchAvailable affectedHosts }',
  '    endOfSupport',
  '    plans { status count estimatedCost ' + MONEY_FIELDS + ' }',
  '    power { racks ratedWatts currentWatts }',
  '    ipam { subnets averageUtilisationPercent critical }',
  '    nodes { total online }',
  '    integrations { total healthy failedLastHour }',
  '    incidentsOpen',
  '    trend { days cis discoveryRuns events incidents }',
  '  }',
  '}',
].join('\n');

export const dashboardsQueryKey = ['dashboards'] as const;

export function dashboardsQuery() {
  return queryOptions({
    queryKey: dashboardsQueryKey,
    queryFn: ({ signal }) => gql<{ dashboards: Dashboard[] }>(DASHBOARDS_QUERY, undefined, signal),
    select: (data) => data.dashboards,
  });
}

export function estateStatsQuery(live: boolean = true) {
  return queryOptions({
    queryKey: ['estate-stats'] as const,
    queryFn: ({ signal }) => gql<{ estateStats: EstateStats }>(ESTATE_STATS_QUERY, undefined, signal),
    select: (data) => data.estateStats,
    refetchInterval: live ? DASHBOARD.refreshMs : false,
  });
}

const CREATE_DASHBOARD = ['mutation CreateDashboard($input: DashboardInput!) {', '  createDashboard(input: $input) { ' + DASHBOARD_FIELDS + ' }', '}'].join('\n');
const UPDATE_DASHBOARD = ['mutation UpdateDashboard($id: UUID!, $input: DashboardInput!) {', '  updateDashboard(id: $id, input: $input) { ' + DASHBOARD_FIELDS + ' }', '}'].join('\n');
const DELETE_DASHBOARD = ['mutation DeleteDashboard($id: UUID!) {', '  deleteDashboard(id: $id)', '}'].join('\n');
const SET_DEFAULT_DASHBOARD = ['mutation SetDefaultDashboard($id: UUID!) {', '  setDefaultDashboard(id: $id) { ' + DASHBOARD_FIELDS + ' }', '}'].join('\n');

export function createDashboard(input: DashboardInput): Promise<Dashboard> {
  return gql<{ createDashboard: Dashboard }>(CREATE_DASHBOARD, { input }).then((d) => d.createDashboard);
}

export function updateDashboard(id: string, input: DashboardInput): Promise<Dashboard> {
  return gql<{ updateDashboard: Dashboard }>(UPDATE_DASHBOARD, { id, input }).then((d) => d.updateDashboard);
}

export function deleteDashboard(id: string): Promise<boolean> {
  return gql<{ deleteDashboard: boolean }>(DELETE_DASHBOARD, { id }).then((d) => d.deleteDashboard);
}

export function setDefaultDashboard(id: string): Promise<Dashboard> {
  return gql<{ setDefaultDashboard: Dashboard }>(SET_DEFAULT_DASHBOARD, { id }).then((d) => d.setDefaultDashboard);
}

/** The input a saved dashboard round-trips through the update mutation (ids are reassigned on write). */
export function toInput(dashboard: Pick<Dashboard, 'name' | 'persona' | 'shared' | 'widgets'>): DashboardInput {
  return { name: dashboard.name, persona: dashboard.persona, shared: dashboard.shared, widgets: dashboard.widgets.map((w) => ({ kind: w.kind, size: w.size, options: w.options })) };
}
