// REQ-UI-004 REQ-UI-005 REQ-UI-006 REQ-UI-007 REQ-UI-008 REQ-UI-012 REQ-UI-013 — typed operations over the frozen
// GraphQL contract (packages/contracts/graphql/schema.graphql) and their TanStack Query option builders. Only the
// fields the console renders are selected.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  CONSOLE,
  GRAPH,
  type AvailabilityGranularity,
  type BSM,
  type Locale,
  type SlaWindow,
} from '@openmap/constants';
import type { CiLayer } from '@openmap/contracts';
import { gql } from './graphql';

export type HealthState = (typeof BSM.healthOrder)[number];
export type PredictedState = (typeof BSM.predictedOrder)[number];
export type ImpactDirection = 'upstream' | 'downstream' | 'both';
export type Lifecycle = 'discovered' | 'managed' | 'planned' | 'retired';

/** JSON scalar as the API returns it: identity and attribute maps are scalars or arrays of scalars. */
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface LayerSummary {
  layer: CiLayer;
  count: number;
  healthy: number;
  degraded: number;
  down: number;
  visible: boolean;
}

export interface CiRef {
  id: string;
  displayName: string;
}

// REQ-BSM-006 REQ-BSM-008 (ADR-024) — SLAs, availability periods, incident response and RCA.
export type IncidentSeverity = 'informational' | 'low' | 'medium' | 'high' | 'critical';
export type IncidentState = 'open' | 'acknowledged' | 'mitigated' | 'resolved' | 'closed';
export type { AvailabilityGranularity, SlaWindow };

export interface SeverityTarget {
  severity: IncidentSeverity;
  respondMinutes: number;
  resolveMinutes: number;
}

export interface Sla {
  id: string;
  name: string;
  description: string;
  availabilityTargetPercent: number;
  window: SlaWindow;
  responseTargets: SeverityTarget[];
  burnRateAlert: number;
  services: CiRef[];
}

export interface AvailabilityPeriod {
  granularity: AvailabilityGranularity | null;
  year: number;
  month: number | null;
  quarter: number | null;
  periodStart: string;
  periodEnd: string;
  current: boolean;
  availabilityPercent: number | null;
  elapsedMinutes: number;
  downtimeMinutes: number;
  degradedMinutes: number;
  unknownMinutes: number;
  targetPercent: number | null;
  met: boolean | null;
  budgetMinutes: number | null;
  budgetRemainingMinutes: number | null;
  burnRate: number | null;
}

export interface PeriodIncidentRef {
  id: string;
  title: string;
  severity: IncidentSeverity;
  state: IncidentState;
  openedAt: string;
  resolvedAt: string | null;
}

export interface ServiceAvailability {
  service: CiRef & { name: string; code: string };
  sla: Pick<Sla, 'id' | 'name'> | null;
  periods: AvailabilityPeriod[];
}

export interface ServiceHealth {
  service: CiRef & { name: string };
  state: HealthState;
  since: string;
  rootCauses: CiRef[];
  slaTarget: number;
  errorBudgetRemainingMinutes: number;
  sla: Pick<Sla, 'id' | 'name' | 'window'> | null;
  currentWindow: AvailabilityPeriod;
}

export const SLA_FIELDS =
  'id name description availabilityTargetPercent window responseTargets { severity respondMinutes resolveMinutes } burnRateAlert services { id displayName }';
export const PERIOD_FIELDS =
  'granularity year month quarter periodStart periodEnd current availabilityPercent elapsedMinutes downtimeMinutes degradedMinutes unknownMinutes targetPercent met budgetMinutes budgetRemainingMinutes burnRate';
const SERVICE_HEALTH_FIELDS = [
  'service { id name displayName }',
  'state since slaTarget errorBudgetRemainingMinutes',
  'rootCauses { id displayName }',
  'sla { id name window }',
  'currentWindow { ' + PERIOD_FIELDS + ' }',
].join(' ');

/** REQ-CMDB-038 — the layer's headline measurement (ADR-016): null value until a collector has sampled it. */
export interface HeadlineMetric {
  key: string;
  label: string;
  unit: string;
  metric: string;
  value: number | null;
  observedAt: string | null;
}

export const HEADLINE_METRIC_FIELDS = 'headlineMetric { key label unit metric value observedAt }';

export interface CiRow {
  id: string;
  code: string;
  type: string;
  layer: CiLayer;
  displayName: string;
  health: HealthState;
  observedAt: string;
  headlineMetric: HeadlineMetric;
}

export interface CiConnection {
  totalCount: number;
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
  edges: Array<{ cursor: string; node: CiRow }>;
}

export interface CiFilterInput {
  layers?: CiLayer[];
  /** CI types to list (the topology site picker lists `site`). */
  types?: string[];
  text?: string;
}

const LAYERS_QUERY = ['query Layers {', '  layers { layer count healthy degraded down visible }', '}'].join(
  '\n',
);

const SERVICES_QUERY = ['query Services {', '  services { ' + SERVICE_HEALTH_FIELDS + ' }', '}'].join('\n');

const SERVICE_QUERY = [
  'query Service($id: UUID!) {',
  '  service(id: $id) { ' + SERVICE_HEALTH_FIELDS + ' }',
  '}',
].join('\n');

export function serviceQuery(id: string) {
  return queryOptions({
    queryKey: ['service', id] as const,
    queryFn: ({ signal }) => gql<{ service: ServiceHealth | null }>(SERVICE_QUERY, { id }, signal),
    select: (data) => data.service,
  });
}

const SERVICE_AVAILABILITY_QUERY = [
  'query ServiceAvailability($id: UUID!, $granularity: AvailabilityGranularity!, $periods: Int) {',
  '  service(id: $id) { availability(granularity: $granularity, periods: $periods) { ' +
    PERIOD_FIELDS +
    ' incidents { id title severity state openedAt resolvedAt } } }',
  '}',
].join('\n');

export type ServicePeriod = AvailabilityPeriod & { incidents: PeriodIncidentRef[] };

export function serviceAvailabilityQuery(
  id: string,
  granularity: AvailabilityGranularity,
  periods: number | null = null,
) {
  return queryOptions({
    queryKey: ['serviceAvailability', id, granularity, periods] as const,
    queryFn: ({ signal }) =>
      gql<{ service: { availability: ServicePeriod[] } | null }>(
        SERVICE_AVAILABILITY_QUERY,
        { id, granularity, periods },
        signal,
      ),
    select: (data) => data.service?.availability ?? [],
  });
}

const AVAILABILITY_REPORT_QUERY = [
  'query AvailabilityReport($granularity: AvailabilityGranularity!, $periods: Int) {',
  '  availabilityReport(granularity: $granularity, periods: $periods) { service { id name displayName code } sla { id name } periods { ' +
    PERIOD_FIELDS +
    ' } }',
  '}',
].join('\n');

export function availabilityReportQuery(granularity: AvailabilityGranularity, periods: number | null = null) {
  return queryOptions({
    queryKey: ['availabilityReport', granularity, periods] as const,
    queryFn: ({ signal }) =>
      gql<{ availabilityReport: ServiceAvailability[] }>(
        AVAILABILITY_REPORT_QUERY,
        { granularity, periods },
        signal,
      ),
    select: (data) => data.availabilityReport,
  });
}

const AVAILABILITY_CSV_QUERY =
  'query AvailabilityReportCsv($granularity: AvailabilityGranularity!, $periods: Int) { availabilityReportCsv(granularity: $granularity, periods: $periods) }';

export function availabilityReportCsv(
  granularity: AvailabilityGranularity,
  periods: number | null = null,
): Promise<string> {
  return gql<{ availabilityReportCsv: string }>(AVAILABILITY_CSV_QUERY, { granularity, periods }).then(
    (d) => d.availabilityReportCsv,
  );
}

const SLAS_QUERY = ['query Slas {', '  slas { ' + SLA_FIELDS + ' }', '}'].join('\n');

export function slasQuery() {
  return queryOptions({
    queryKey: ['slas'] as const,
    queryFn: ({ signal }) => gql<{ slas: Sla[] }>(SLAS_QUERY, undefined, signal),
    select: (data) => data.slas,
  });
}

export interface SeverityTargetInput {
  severity: IncidentSeverity;
  respondMinutes: number;
  resolveMinutes: number;
}

export interface SlaInput {
  name: string;
  description?: string;
  availabilityTargetPercent: number;
  window: SlaWindow;
  responseTargets?: SeverityTargetInput[];
  burnRateAlert?: number;
}

export function upsertSla(id: string | null, input: SlaInput): Promise<Sla> {
  return gql<{ upsertSla: Sla }>(
    'mutation UpsertSla($id: UUID, $input: SlaInput!) { upsertSla(id: $id, input: $input) { ' +
      SLA_FIELDS +
      ' } }',
    { id, input },
  ).then((d) => d.upsertSla);
}

export function deleteSla(id: string): Promise<boolean> {
  return gql<{ deleteSla: boolean }>('mutation DeleteSla($id: UUID!) { deleteSla(id: $id) }', { id }).then(
    (d) => d.deleteSla,
  );
}

export function assignSla(serviceId: string, slaId: string | null): Promise<ServiceHealth> {
  return gql<{ assignSla: ServiceHealth }>(
    'mutation AssignSla($serviceId: UUID!, $slaId: UUID) { assignSla(serviceId: $serviceId, slaId: $slaId) { ' +
      SERVICE_HEALTH_FIELDS +
      ' } }',
    { serviceId, slaId },
  ).then((d) => d.assignSla);
}

const CIS_QUERY = [
  'query Cis($filter: CiFilter, $first: Int, $after: String) {',
  '  cis(filter: $filter, first: $first, after: $after) {',
  '    totalCount',
  '    pageInfo { endCursor hasNextPage }',
  '    edges { cursor node { id code type layer displayName health observedAt ' +
    HEADLINE_METRIC_FIELDS +
    ' } }',
  '  }',
  '}',
].join('\n');

export const queryKeys = {
  layers: ['layers'] as const,
  services: ['services'] as const,
  cis: (filter: CiFilterInput) => ['cis', filter] as const,
};

export function layersQuery() {
  return queryOptions({
    queryKey: queryKeys.layers,
    queryFn: ({ signal }) => gql<{ layers: LayerSummary[] }>(LAYERS_QUERY, undefined, signal),
    select: (data) => data.layers,
  });
}

export function servicesQuery() {
  return queryOptions({
    queryKey: queryKeys.services,
    queryFn: ({ signal }) => gql<{ services: ServiceHealth[] }>(SERVICES_QUERY, undefined, signal),
    select: (data) => data.services,
  });
}

export function cisInfiniteQuery(filter: CiFilterInput) {
  return infiniteQueryOptions({
    queryKey: queryKeys.cis(filter),
    queryFn: ({ pageParam, signal }) =>
      gql<{ cis: CiConnection }>(
        CIS_QUERY,
        { filter, first: GRAPH.defaultPageSize, after: pageParam },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.cis.pageInfo.hasNextPage ? last.cis.pageInfo.endCursor : undefined),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// CI summaries shared by several screens
// ---------------------------------------------------------------------------------------------------------------

export interface CiSummary {
  id: string;
  name: string;
  displayName: string;
  /** Short code (ADR-014), unique per tenant, editable by operators. */
  code: string;
  type: string;
  layer: CiLayer;
  health: HealthState;
  /** Present only where a screen renders it (search hits, the impact root, the CI detail): the other summaries stay lean. */
  headlineMetric?: HeadlineMetric;
}

export const CI_SUMMARY_FIELDS = 'id name displayName code type layer health';
/** REQ-CMDB-038 — a summary with its headline metric; selected only where the metric is shown, since it costs a ClickHouse round trip per page. */
export const CI_SUMMARY_METRIC_FIELDS = CI_SUMMARY_FIELDS + ' ' + HEADLINE_METRIC_FIELDS;

export interface SearchHit {
  ci: CiSummary;
  score: number;
  highlight: string | null;
}

const SEARCH_QUERY = [
  'query Search($text: String!, $layers: [CiLayer!], $first: Int) {',
  '  search(text: $text, layers: $layers, first: $first) {',
  '    ci { ' + CI_SUMMARY_METRIC_FIELDS + ' }',
  '    score highlight',
  '  }',
  '}',
].join('\n');

export interface SearchInput {
  text: string;
  layers?: CiLayer[];
  first?: number;
}

export function searchQuery(input: SearchInput) {
  const variables = {
    text: input.text,
    layers: input.layers ?? null,
    first: input.first ?? CONSOLE.searchResultLimit,
  };
  return queryOptions({
    queryKey: ['search', variables] as const,
    queryFn: ({ signal }) => gql<{ search: SearchHit[] }>(SEARCH_QUERY, variables, signal),
    select: (data) => data.search,
    enabled: input.text.trim() !== '',
  });
}

const CIS_PAGE_QUERY = [
  'query CisPage($filter: CiFilter, $first: Int) {',
  '  cis(filter: $filter, first: $first) {',
  '    totalCount',
  '    edges { node { ' + CI_SUMMARY_FIELDS + ' } }',
  '  }',
  '}',
].join('\n');

/** One page of CIs for pickers and explorers (no cursor paging; the explorer narrows by search instead). */
export function cisPageQuery(filter: CiFilterInput, first: number = CONSOLE.explorerPageSize) {
  return queryOptions({
    queryKey: ['cis-page', filter, first] as const,
    queryFn: ({ signal }) =>
      gql<{ cis: { totalCount: number; edges: Array<{ node: CiSummary }> } }>(
        CIS_PAGE_QUERY,
        { filter, first },
        signal,
      ),
    select: (data) => ({ totalCount: data.cis.totalCount, items: data.cis.edges.map((edge) => edge.node) }),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Impact (dependency map) — REQ-UI-007 REQ-DEP-003
// ---------------------------------------------------------------------------------------------------------------

export interface Money {
  amount: number;
  currency: string;
}

export interface ImpactNode {
  ci: CiSummary;
  depth: number;
  predicted: PredictedState;
  path: string[];
}

export interface Recovery {
  description: string;
  estimatedMinutes: number;
}

export interface AffectedService {
  service: CiSummary;
  tier: number;
  predicted: PredictedState;
  path: string[];
  usersAffected: number | null;
  revenueAtRiskPerHour: Money | null;
  slaBudgetRemainingMinutes: number | null;
  recovery: Recovery | null;
}

export interface ImpactResult {
  root: CiSummary;
  nodes: ImpactNode[];
  services: AffectedService[];
  durationMs: number;
}

const AFFECTED_SERVICE_FIELDS = [
  'service { ' + CI_SUMMARY_FIELDS + ' }',
  'tier predicted path usersAffected slaBudgetRemainingMinutes',
  'revenueAtRiskPerHour { amount currency }',
  'recovery { description estimatedMinutes }',
].join(' ');

const IMPACT_QUERY = [
  'query Impact($ciId: UUID!, $direction: Direction, $maxDepth: Int, $asOf: DateTime) {',
  '  impact(ciId: $ciId, direction: $direction, maxDepth: $maxDepth, asOf: $asOf) {',
  '    root { ' + CI_SUMMARY_METRIC_FIELDS + ' }',
  '    nodes { ci { ' + CI_SUMMARY_FIELDS + ' } depth predicted path }',
  '    services { ' + AFFECTED_SERVICE_FIELDS + ' }',
  '    durationMs',
  '  }',
  '}',
].join('\n');

export interface ImpactInput {
  ciId: string;
  direction: ImpactDirection;
  maxDepth: number;
  /** ISO timestamp for time travel; null means now. */
  asOf: string | null;
}

export function impactQuery(input: ImpactInput) {
  return queryOptions({
    queryKey: ['impact', input] as const,
    queryFn: ({ signal }) => gql<{ impact: ImpactResult }>(IMPACT_QUERY, { ...input }, signal),
    select: (data) => data.impact,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// CI detail — REQ-UI-008 REQ-CMDB-037
// ---------------------------------------------------------------------------------------------------------------

export interface Provenance {
  collectorId: string;
  nodeId: string;
  runId: string;
  confidence: number;
}

export interface ExternalId {
  source: string;
  id: string;
}

export interface UserLabel {
  title: string;
  description: string;
  layer: CiLayer;
  type: string | null;
  labelledBy: string;
  labelledAt: string;
}

export interface RelationshipRow {
  id: string;
  type: string;
  from: CiSummary;
  to: CiSummary;
  /** REQ-DEP-002: the evidence a derived edge carries (flows, ports, processes, window, confidence). */
  attributes: Record<string, JsonValue>;
  source: Provenance;
  validFrom: string;
  validTo: string | null;
}

export interface CiDetail extends CiSummary {
  headlineMetric: HeadlineMetric;
  identity: Record<string, JsonValue>;
  attributes: Record<string, JsonValue>;
  tags: string[];
  externalIds: ExternalId[];
  lifecycle: Lifecycle;
  userLabel: UserLabel | null;
  source: Provenance;
  observedAt: string;
  validFrom: string;
  validTo: string | null;
  relationships: {
    totalCount: number;
    edges: Array<{ node: RelationshipRow }>;
  };
}

const CI_DETAIL_QUERY = [
  'query CiDetail($id: UUID!, $asOf: DateTime, $first: Int) {',
  '  ci(id: $id, asOf: $asOf) {',
  '    ' + CI_SUMMARY_METRIC_FIELDS,
  '    identity attributes tags lifecycle observedAt validFrom validTo',
  '    externalIds { source id }',
  '    userLabel { title description layer type labelledBy labelledAt }',
  '    source { collectorId nodeId runId confidence }',
  '    relationships(first: $first) {',
  '      totalCount',
  '      edges { node { id type validFrom validTo attributes source { collectorId nodeId runId confidence } from { ' +
    CI_SUMMARY_FIELDS +
    ' } to { ' +
    CI_SUMMARY_FIELDS +
    ' } } }',
  '    }',
  '  }',
  '}',
].join('\n');

export function ciDetailQuery(id: string, asOf: string | null = null) {
  return queryOptions({
    queryKey: ['ci', id, asOf] as const,
    queryFn: ({ signal }) =>
      gql<{ ci: CiDetail | null }>(
        CI_DETAIL_QUERY,
        { id, asOf, first: CONSOLE.relationshipsPageSize },
        signal,
      ),
    select: (data) => data.ci,
  });
}

export interface LabelCiInput {
  ciId: string;
  title: string;
  description: string;
  layer: CiLayer;
  type?: string;
}

const LABEL_CI_MUTATION = [
  'mutation LabelCi($input: LabelCiInput!) {',
  '  labelCi(input: $input) { ' + CI_SUMMARY_FIELDS + ' }',
  '}',
].join('\n');

export function labelCi(input: LabelCiInput): Promise<CiSummary> {
  return gql<{ labelCi: CiSummary }>(LABEL_CI_MUTATION, { input }).then((data) => data.labelCi);
}

// REQ-CMDB-037 — rename a short code (ADR-014); the server upper-cases, validates the pattern and refuses a taken code.
const SET_CI_CODE_MUTATION = [
  'mutation SetCiCode($ciId: UUID!, $code: String!) {',
  '  setCiCode(ciId: $ciId, code: $code) { ' + CI_SUMMARY_FIELDS + ' }',
  '}',
].join('\n');

export function setCiCode(ciId: string, code: string): Promise<CiSummary> {
  return gql<{ setCiCode: CiSummary }>(SET_CI_CODE_MUTATION, { ciId, code }).then((data) => data.setCiCode);
}

// ---------------------------------------------------------------------------------------------------------------
// Impact modeling — REQ-UI-013 REQ-BSM-003 REQ-AI-004
// ---------------------------------------------------------------------------------------------------------------

export interface ImpactScenario {
  id: string;
  name: string;
  kind: string;
  failedCis: CiSummary[];
  options: Record<string, JsonValue>;
  createdBy: string;
  createdAt: string;
}

export interface ImpactTotals {
  servicesDown: number;
  servicesDegraded: number;
  usersAffected: number;
  revenueAtRiskPerHour: Money | null;
}

export interface Recommendation {
  title: string;
  rationale: string;
  estimatedMinutes: number | null;
}

export interface ImpactSimulation {
  id: string;
  scenario: ImpactScenario;
  ranAt: string;
  durationMs: number;
  failedCis: CiSummary[];
  affectedApplications: CiSummary[];
  services: AffectedService[];
  totals: ImpactTotals;
  recommendations: Recommendation[];
}

const SCENARIO_FIELDS = 'id name kind options createdBy createdAt failedCis { ' + CI_SUMMARY_FIELDS + ' }';

const SIMULATION_FIELDS = [
  'id ranAt durationMs',
  'scenario { ' + SCENARIO_FIELDS + ' }',
  'failedCis { ' + CI_SUMMARY_FIELDS + ' }',
  'affectedApplications { ' + CI_SUMMARY_FIELDS + ' }',
  'services { ' + AFFECTED_SERVICE_FIELDS + ' }',
  'totals { servicesDown servicesDegraded usersAffected revenueAtRiskPerHour { amount currency } }',
  'recommendations { title rationale estimatedMinutes }',
].join(' ');

const SCENARIOS_QUERY = [
  'query ImpactScenarios {',
  '  impactScenarios { ' + SCENARIO_FIELDS + ' }',
  '}',
].join('\n');

export function impactScenariosQuery() {
  return queryOptions({
    queryKey: ['impact-scenarios'] as const,
    queryFn: ({ signal }) => gql<{ impactScenarios: ImpactScenario[] }>(SCENARIOS_QUERY, undefined, signal),
    select: (data) => data.impactScenarios,
  });
}

const SIMULATION_QUERY = [
  'query ImpactSimulation($id: UUID!) {',
  '  impactSimulation(id: $id) { ' + SIMULATION_FIELDS + ' }',
  '}',
].join('\n');

export function impactSimulationQuery(id: string) {
  return queryOptions({
    queryKey: ['impact-simulation', id] as const,
    queryFn: ({ signal }) =>
      gql<{ impactSimulation: ImpactSimulation | null }>(SIMULATION_QUERY, { id }, signal),
    select: (data) => data.impactSimulation,
  });
}

export interface ScenarioInput {
  name: string;
  kind: string;
  failedCiIds: string[];
  maxDepth?: number;
  honourRedundancy?: boolean;
  includeSharedServices?: boolean;
  at?: string;
}

const SAVE_SCENARIO_MUTATION = [
  'mutation SaveScenario($input: ScenarioInput!) {',
  '  saveScenario(input: $input) { ' + SCENARIO_FIELDS + ' }',
  '}',
].join('\n');

export function saveScenario(input: ScenarioInput): Promise<ImpactScenario> {
  return gql<{ saveScenario: ImpactScenario }>(SAVE_SCENARIO_MUTATION, { input }).then(
    (data) => data.saveScenario,
  );
}

const RUN_SIMULATION_MUTATION = [
  'mutation RunSimulation($scenarioId: UUID!) {',
  '  runSimulation(scenarioId: $scenarioId) { ' + SIMULATION_FIELDS + ' }',
  '}',
].join('\n');

export function runSimulation(scenarioId: string): Promise<ImpactSimulation> {
  return gql<{ runSimulation: ImpactSimulation }>(RUN_SIMULATION_MUTATION, { scenarioId }).then(
    (data) => data.runSimulation,
  );
}

// REQ-AI-007 (ADR-028) — the conversational answer as the Impact screen reads it; the Assistant screen's richer
// typing lives in estate-queries.ts and both ask the same mutation.
export interface AssistantAnswer {
  text: string;
  cypher: string;
  rows: JsonValue;
  cis: CiSummary[];
  intent: string;
  confidence: number;
  grounded: boolean;
  figures: Array<{ label: string; value: number; unit: string }>;
  evidence: Array<{
    skill: string;
    store: string;
    query: string;
    params: JsonValue;
    rows: number;
    durationMs: number;
    error: string | null;
  }>;
  followUps: string[];
  clarification: { question: string; options: Array<{ label: string; value: string }> } | null;
}

const ASK_ASSISTANT_MUTATION = [
  'mutation AskAssistant($question: String!, $locale: String) {',
  '  askAssistant(question: $question, locale: $locale) { text cypher rows intent confidence grounded figures { label value unit } evidence { skill store query params rows durationMs error } followUps clarification { question options { label value } } cis { ' +
    CI_SUMMARY_FIELDS +
    ' } }',
  '}',
].join('\n');

export function askAssistant(question: string, locale: Locale): Promise<AssistantAnswer> {
  return gql<{ askAssistant: AssistantAnswer }>(ASK_ASSISTANT_MUTATION, { question, locale }).then(
    (data) => data.askAssistant,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Business services and incidents — REQ-UI-012 REQ-BSM-002
// ---------------------------------------------------------------------------------------------------------------

export interface IncidentLink {
  integration: { id: string; vendor: string; name: string };
  remoteId: string;
  remoteUrl: string | null;
  remoteState: string;
  syncedAt: string;
}

export interface CorrectiveAction {
  description: string;
  owner: string | null;
  dueAt: string | null;
  done: boolean;
}

export interface Rca {
  summary: string;
  rootCauseCi: CiSummary | null;
  contributingFactors: string[];
  correctiveActions: CorrectiveAction[];
  owner: string | null;
  dueAt: string | null;
  completedAt: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface IncidentEvent {
  at: string;
  actor: string;
  kind: string;
  details: Record<string, JsonValue>;
}

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  state: IncidentState;
  source: string;
  service: CiSummary;
  sla: Pick<Sla, 'id' | 'name'> | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  assignee: string | null;
  respondBy: string | null;
  resolveBy: string | null;
  responseBreachedAt: string | null;
  resolutionBreachedAt: string | null;
  resolutionNote: string | null;
  rootCause: CiSummary | null;
  alerts: number;
  links: IncidentLink[];
  rca: Rca | null;
  timeline: IncidentEvent[];
}

const INCIDENT_FIELDS = [
  'id title description severity state source openedAt acknowledgedAt resolvedAt closedAt assignee respondBy resolveBy responseBreachedAt resolutionBreachedAt resolutionNote alerts',
  'service { ' + CI_SUMMARY_FIELDS + ' }',
  'sla { id name }',
  'rootCause { ' + CI_SUMMARY_FIELDS + ' }',
  'links { integration { id vendor name } remoteId remoteUrl remoteState syncedAt }',
  'rca { summary rootCauseCi { ' +
    CI_SUMMARY_FIELDS +
    ' } contributingFactors correctiveActions { description owner dueAt done } owner dueAt completedAt updatedBy updatedAt }',
  'timeline { at actor kind details }',
].join(' ');

const INCIDENTS_QUERY = [
  'query Incidents($open: Boolean, $serviceId: UUID) {',
  '  incidents(open: $open, serviceId: $serviceId) { ' + INCIDENT_FIELDS + ' }',
  '}',
].join('\n');

export function incidentsQuery(open: boolean = true, serviceId: string | null = null) {
  return queryOptions({
    queryKey: ['incidents', open, serviceId] as const,
    queryFn: ({ signal }) => gql<{ incidents: Incident[] }>(INCIDENTS_QUERY, { open, serviceId }, signal),
    select: (data) => data.incidents,
  });
}

function incidentMutation(name: string, args: string, call: string): string {
  return ['mutation ' + name + '(' + args + ') {', '  ' + call + ' { ' + INCIDENT_FIELDS + ' }', '}'].join(
    '\n',
  );
}

const ASSIGN_MUTATION = incidentMutation(
  'AssignIncident',
  '$incidentId: UUID!, $assignee: String!',
  'assignIncident(incidentId: $incidentId, assignee: $assignee)',
);
const RESOLVE_MUTATION = incidentMutation(
  'ResolveIncident',
  '$incidentId: UUID!, $note: String!',
  'resolveIncident(incidentId: $incidentId, note: $note)',
);
const CLOSE_MUTATION = incidentMutation(
  'CloseIncident',
  '$incidentId: UUID!',
  'closeIncident(incidentId: $incidentId)',
);
const RCA_MUTATION = incidentMutation(
  'UpdateIncidentRca',
  '$incidentId: UUID!, $input: RcaInput!',
  'updateIncidentRca(incidentId: $incidentId, input: $input)',
);

export function assignIncident(incidentId: string, assignee: string): Promise<Incident> {
  return gql<{ assignIncident: Incident }>(ASSIGN_MUTATION, { incidentId, assignee }).then(
    (d) => d.assignIncident,
  );
}

export function resolveIncident(incidentId: string, note: string): Promise<Incident> {
  return gql<{ resolveIncident: Incident }>(RESOLVE_MUTATION, { incidentId, note }).then(
    (d) => d.resolveIncident,
  );
}

export function closeIncident(incidentId: string): Promise<Incident> {
  return gql<{ closeIncident: Incident }>(CLOSE_MUTATION, { incidentId }).then((d) => d.closeIncident);
}

export interface CorrectiveActionInput {
  description: string;
  owner?: string | null;
  dueAt?: string | null;
  done?: boolean;
}

export interface RcaInput {
  summary: string;
  rootCauseCiId?: string | null;
  contributingFactors?: string[];
  correctiveActions?: CorrectiveActionInput[];
  owner?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
}

export function updateIncidentRca(incidentId: string, input: RcaInput): Promise<Incident> {
  return gql<{ updateIncidentRca: Incident }>(RCA_MUTATION, { incidentId, input }).then(
    (d) => d.updateIncidentRca,
  );
}

const ACKNOWLEDGE_MUTATION = [
  'mutation AcknowledgeIncident($incidentId: UUID!) {',
  '  acknowledgeIncident(incidentId: $incidentId) { ' + INCIDENT_FIELDS + ' }',
  '}',
].join('\n');

export function acknowledgeIncident(incidentId: string): Promise<Incident> {
  return gql<{ acknowledgeIncident: Incident }>(ACKNOWLEDGE_MUTATION, { incidentId }).then(
    (data) => data.acknowledgeIncident,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery — REQ-UI-006 REQ-DISC-029 REQ-DISC-031
// ---------------------------------------------------------------------------------------------------------------

export interface DiscoveryNode {
  id: string;
  site: CiRef | null;
  status: string;
  lastHeartbeat: string;
  activeJobs: number;
  certificateExpiresAt: string;
}

export interface DiscoveryJob {
  id: string;
  collectorId: string;
  node: { id: string };
  status: string;
  targets: number;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cisEmitted: number;
  errors: number;
}

export interface Sweep {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  targetsTotal: number;
  targetsDone: number;
  devicesDiscovered: number;
  budgetMinutes: number;
}

const SWEEP_FIELDS = 'id startedAt finishedAt targetsTotal targetsDone devicesDiscovered budgetMinutes';

const DISCOVERY_NODES_QUERY = [
  'query DiscoveryNodes {',
  '  discoveryNodes { id status lastHeartbeat activeJobs certificateExpiresAt site { id displayName } }',
  '}',
].join('\n');

export function discoveryNodesQuery() {
  return queryOptions({
    queryKey: ['discovery-nodes'] as const,
    queryFn: ({ signal }) =>
      gql<{ discoveryNodes: DiscoveryNode[] }>(DISCOVERY_NODES_QUERY, undefined, signal),
    select: (data) => data.discoveryNodes,
    refetchInterval: CONSOLE.livePollMs,
  });
}

const DISCOVERY_JOBS_QUERY = [
  'query DiscoveryJobs($status: String, $first: Int) {',
  '  discoveryJobs(status: $status, first: $first) {',
  '    id collectorId status targets scheduledAt startedAt finishedAt cisEmitted errors node { id }',
  '  }',
  '}',
].join('\n');

export function discoveryJobsQuery(status: string | null = null) {
  return queryOptions({
    queryKey: ['discovery-jobs', status] as const,
    queryFn: ({ signal }) =>
      gql<{ discoveryJobs: DiscoveryJob[] }>(
        DISCOVERY_JOBS_QUERY,
        { status, first: CONSOLE.discoveryJobsLimit },
        signal,
      ),
    select: (data) => data.discoveryJobs,
    refetchInterval: CONSOLE.livePollMs,
  });
}

const CURRENT_SWEEP_QUERY = ['query CurrentSweep {', '  currentSweep { ' + SWEEP_FIELDS + ' }', '}'].join(
  '\n',
);

export function currentSweepQuery() {
  return queryOptions({
    queryKey: ['current-sweep'] as const,
    queryFn: ({ signal }) => gql<{ currentSweep: Sweep | null }>(CURRENT_SWEEP_QUERY, undefined, signal),
    select: (data) => data.currentSweep,
    refetchInterval: CONSOLE.livePollMs,
  });
}

export interface DiscoveryScope {
  ci: CiSummary;
  cidr: string;
  site: CiSummary | null;
  exclusions: string[];
  credentialRef: string | null;
  credentialType: string;
  rateLimitConcurrency: number | null;
  rateLimitRps: number | null;
}

export interface DiscoveryScopeInput {
  exclusions?: string[];
  credentialRef?: string | null;
  credentialType?: string;
  rateLimitConcurrency?: number | null;
  rateLimitRps?: number | null;
}

const SCOPE_FIELDS =
  'ci { ' +
  CI_SUMMARY_FIELDS +
  ' } cidr site { ' +
  CI_SUMMARY_FIELDS +
  ' } exclusions credentialRef credentialType rateLimitConcurrency rateLimitRps';
const DISCOVERY_SCOPES_QUERY = [
  'query DiscoveryScopes {',
  '  discoveryScopes { ' + SCOPE_FIELDS + ' }',
  '}',
].join('\n');

// REQ-DISC-029 — subnets as discovery scopes with their exclusions, credential set and rate limit (ADR-015).
export function discoveryScopesQuery() {
  return queryOptions({
    queryKey: ['discovery-scopes'] as const,
    queryFn: ({ signal }) =>
      gql<{ discoveryScopes: DiscoveryScope[] }>(DISCOVERY_SCOPES_QUERY, undefined, signal),
    select: (data) => data.discoveryScopes,
  });
}

const UPDATE_SCOPE_MUTATION = [
  'mutation UpdateDiscoveryScope($ciId: UUID!, $input: DiscoveryScopeInput!) {',
  '  updateDiscoveryScope(ciId: $ciId, input: $input) { ' + SCOPE_FIELDS + ' }',
  '}',
].join('\n');

export function updateDiscoveryScope(ciId: string, input: DiscoveryScopeInput): Promise<DiscoveryScope> {
  return gql<{ updateDiscoveryScope: DiscoveryScope }>(UPDATE_SCOPE_MUTATION, { ciId, input }).then(
    (data) => data.updateDiscoveryScope,
  );
}

const RUN_DISCOVERY_MUTATION = [
  'mutation RunDiscovery($collectorIds: [String!], $siteId: UUID) {',
  '  runDiscovery(collectorIds: $collectorIds, siteId: $siteId) { ' + SWEEP_FIELDS + ' }',
  '}',
].join('\n');

export function runDiscovery(
  collectorIds: string[] | null = null,
  siteId: string | null = null,
): Promise<Sweep> {
  return gql<{ runDiscovery: Sweep }>(RUN_DISCOVERY_MUTATION, { collectorIds, siteId }).then(
    (data) => data.runDiscovery,
  );
}

// REQ-SEC-005 — the tenant's immutable audit log, newest first, paged by cursor.
export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string;
  details: Record<string, unknown>;
  traceparent: string | null;
}

export interface AuditPage {
  edges: Array<{ cursor: string; node: AuditEntry }>;
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
  totalCount: number;
}

export interface AuditFilterInput {
  action?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  actor?: string | null;
}

const AUDIT_LOG_QUERY = [
  'query AuditLog($action: String, $subjectType: String, $subjectId: String, $actor: String, $first: Int, $after: String) {',
  '  auditLog(action: $action, subjectType: $subjectType, subjectId: $subjectId, actor: $actor, first: $first, after: $after) {',
  '    edges { cursor node { id at actor action subjectType subjectId details traceparent } }',
  '    pageInfo { endCursor hasNextPage }',
  '    totalCount',
  '  }',
  '}',
].join('\n');

export function auditLogInfiniteQuery(filter: AuditFilterInput) {
  return infiniteQueryOptions({
    queryKey: ['auditLog', filter] as const,
    queryFn: ({ pageParam, signal }) =>
      gql<{ auditLog: AuditPage }>(
        AUDIT_LOG_QUERY,
        { ...filter, first: CONSOLE.explorerPageSize, after: pageParam },
        signal,
      ).then((d) => d.auditLog),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? last.pageInfo.endCursor : null),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Tenant settings — REQ-UI-019 REQ-CORE-012 (ADR-011)
// ---------------------------------------------------------------------------------------------------------------

export interface TenantSettingsView {
  locale: string;
  timeZone: string;
  discoveryIntervalMinutes: number;
  historyRetentionDays: number;
  staleAfterDays: number;
  auditRetentionDays: number;
  assistantEnabled: boolean;
  outboundIntegrationsEnabled: boolean;
}

export type TenantSettingsPatch = Partial<TenantSettingsView>;

const TENANT_SETTINGS_FIELDS =
  'locale timeZone discoveryIntervalMinutes historyRetentionDays staleAfterDays auditRetentionDays assistantEnabled outboundIntegrationsEnabled';
const TENANT_SETTINGS_QUERY = 'query TenantSettings { tenantSettings { ' + TENANT_SETTINGS_FIELDS + ' } }';
const UPDATE_TENANT_SETTINGS_MUTATION =
  'mutation UpdateTenantSettings($input: TenantSettingsInput!) { updateTenantSettings(input: $input) { ' +
  TENANT_SETTINGS_FIELDS +
  ' } }';

export function tenantSettingsQuery() {
  return queryOptions({
    queryKey: ['tenantSettings'] as const,
    queryFn: ({ signal }) =>
      gql<{ tenantSettings: TenantSettingsView }>(TENANT_SETTINGS_QUERY, {}, signal).then(
        (d) => d.tenantSettings,
      ),
  });
}

export function updateTenantSettings(input: TenantSettingsPatch): Promise<TenantSettingsView> {
  return gql<{ updateTenantSettings: TenantSettingsView }>(UPDATE_TENANT_SETTINGS_MUTATION, { input }).then(
    (d) => d.updateTenantSettings,
  );
}
