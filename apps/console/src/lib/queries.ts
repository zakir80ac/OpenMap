// REQ-UI-004 REQ-UI-005 REQ-UI-006 REQ-UI-007 REQ-UI-008 REQ-UI-012 REQ-UI-013 — typed operations over the frozen
// GraphQL contract (packages/contracts/graphql/schema.graphql) and their TanStack Query option builders. Only the
// fields the console renders are selected.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { CONSOLE, GRAPH, type BSM } from '@openmap/constants';
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

export interface ServiceHealth {
  service: CiRef & { name: string };
  state: HealthState;
  since: string;
  rootCauses: CiRef[];
  slaTarget: number;
  errorBudgetRemainingMinutes: number;
}

export interface CiRow {
  id: string;
  type: string;
  layer: CiLayer;
  displayName: string;
  health: HealthState;
  observedAt: string;
}

export interface CiConnection {
  totalCount: number;
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
  edges: Array<{ cursor: string; node: CiRow }>;
}

export interface CiFilterInput {
  layers?: CiLayer[];
  text?: string;
}

const LAYERS_QUERY = ['query Layers {', '  layers { layer count healthy degraded down visible }', '}'].join('\n');

const SERVICES_QUERY = [
  'query Services {',
  '  services {',
  '    service { id name displayName }',
  '    state since slaTarget errorBudgetRemainingMinutes',
  '    rootCauses { id displayName }',
  '  }',
  '}',
].join('\n');

const CIS_QUERY = [
  'query Cis($filter: CiFilter, $first: Int, $after: String) {',
  '  cis(filter: $filter, first: $first, after: $after) {',
  '    totalCount',
  '    pageInfo { endCursor hasNextPage }',
  '    edges { cursor node { id type layer displayName health observedAt } }',
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
      gql<{ cis: CiConnection }>(CIS_QUERY, { filter, first: GRAPH.defaultPageSize, after: pageParam }, signal),
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
  type: string;
  layer: CiLayer;
  health: HealthState;
}

const CI_SUMMARY_FIELDS = 'id name displayName type layer health';

export interface SearchHit {
  ci: CiSummary;
  score: number;
  highlight: string | null;
}

const SEARCH_QUERY = [
  'query Search($text: String!, $layers: [CiLayer!], $first: Int) {',
  '  search(text: $text, layers: $layers, first: $first) {',
  '    ci { ' + CI_SUMMARY_FIELDS + ' }',
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
  const variables = { text: input.text, layers: input.layers ?? null, first: input.first ?? CONSOLE.searchResultLimit };
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
      gql<{ cis: { totalCount: number; edges: Array<{ node: CiSummary }> } }>(CIS_PAGE_QUERY, { filter, first }, signal),
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
  '    root { ' + CI_SUMMARY_FIELDS + ' }',
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
  validFrom: string;
  validTo: string | null;
}

export interface CiDetail extends CiSummary {
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
  '    ' + CI_SUMMARY_FIELDS,
  '    identity attributes tags lifecycle observedAt validFrom validTo',
  '    externalIds { source id }',
  '    userLabel { title description layer type labelledBy labelledAt }',
  '    source { collectorId nodeId runId confidence }',
  '    relationships(first: $first) {',
  '      totalCount',
  '      edges { node { id type validFrom validTo from { ' + CI_SUMMARY_FIELDS + ' } to { ' + CI_SUMMARY_FIELDS + ' } } }',
  '    }',
  '  }',
  '}',
].join('\n');

export function ciDetailQuery(id: string, asOf: string | null = null) {
  return queryOptions({
    queryKey: ['ci', id, asOf] as const,
    queryFn: ({ signal }) =>
      gql<{ ci: CiDetail | null }>(CI_DETAIL_QUERY, { id, asOf, first: CONSOLE.relationshipsPageSize }, signal),
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

const LABEL_CI_MUTATION = ['mutation LabelCi($input: LabelCiInput!) {', '  labelCi(input: $input) { ' + CI_SUMMARY_FIELDS + ' }', '}'].join('\n');

export function labelCi(input: LabelCiInput): Promise<CiSummary> {
  return gql<{ labelCi: CiSummary }>(LABEL_CI_MUTATION, { input }).then((data) => data.labelCi);
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

const SCENARIOS_QUERY = ['query ImpactScenarios {', '  impactScenarios { ' + SCENARIO_FIELDS + ' }', '}'].join('\n');

export function impactScenariosQuery() {
  return queryOptions({
    queryKey: ['impact-scenarios'] as const,
    queryFn: ({ signal }) => gql<{ impactScenarios: ImpactScenario[] }>(SCENARIOS_QUERY, undefined, signal),
    select: (data) => data.impactScenarios,
  });
}

const SIMULATION_QUERY = ['query ImpactSimulation($id: UUID!) {', '  impactSimulation(id: $id) { ' + SIMULATION_FIELDS + ' }', '}'].join('\n');

export function impactSimulationQuery(id: string) {
  return queryOptions({
    queryKey: ['impact-simulation', id] as const,
    queryFn: ({ signal }) => gql<{ impactSimulation: ImpactSimulation | null }>(SIMULATION_QUERY, { id }, signal),
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

const SAVE_SCENARIO_MUTATION = ['mutation SaveScenario($input: ScenarioInput!) {', '  saveScenario(input: $input) { ' + SCENARIO_FIELDS + ' }', '}'].join('\n');

export function saveScenario(input: ScenarioInput): Promise<ImpactScenario> {
  return gql<{ saveScenario: ImpactScenario }>(SAVE_SCENARIO_MUTATION, { input }).then((data) => data.saveScenario);
}

const RUN_SIMULATION_MUTATION = ['mutation RunSimulation($scenarioId: UUID!) {', '  runSimulation(scenarioId: $scenarioId) { ' + SIMULATION_FIELDS + ' }', '}'].join('\n');

export function runSimulation(scenarioId: string): Promise<ImpactSimulation> {
  return gql<{ runSimulation: ImpactSimulation }>(RUN_SIMULATION_MUTATION, { scenarioId }).then((data) => data.runSimulation);
}

export interface AssistantAnswer {
  text: string;
  cypher: string;
  rows: JsonValue;
  cis: CiSummary[];
}

const ASK_ASSISTANT_MUTATION = [
  'mutation AskAssistant($question: String!) {',
  '  askAssistant(question: $question) { text cypher rows cis { ' + CI_SUMMARY_FIELDS + ' } }',
  '}',
].join('\n');

export function askAssistant(question: string): Promise<AssistantAnswer> {
  return gql<{ askAssistant: AssistantAnswer }>(ASK_ASSISTANT_MUTATION, { question }).then((data) => data.askAssistant);
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

export interface Incident {
  id: string;
  service: CiSummary;
  openedAt: string;
  resolvedAt: string | null;
  rootCause: CiSummary | null;
  alerts: number;
  links: IncidentLink[];
}

const INCIDENT_FIELDS = [
  'id openedAt resolvedAt alerts',
  'service { ' + CI_SUMMARY_FIELDS + ' }',
  'rootCause { ' + CI_SUMMARY_FIELDS + ' }',
  'links { integration { id vendor name } remoteId remoteUrl remoteState syncedAt }',
].join(' ');

const INCIDENTS_QUERY = ['query Incidents($open: Boolean) {', '  incidents(open: $open) { ' + INCIDENT_FIELDS + ' }', '}'].join('\n');

export function incidentsQuery(open: boolean = true) {
  return queryOptions({
    queryKey: ['incidents', open] as const,
    queryFn: ({ signal }) => gql<{ incidents: Incident[] }>(INCIDENTS_QUERY, { open }, signal),
    select: (data) => data.incidents,
  });
}

const ACKNOWLEDGE_MUTATION = [
  'mutation AcknowledgeIncident($incidentId: UUID!) {',
  '  acknowledgeIncident(incidentId: $incidentId) { ' + INCIDENT_FIELDS + ' }',
  '}',
].join('\n');

export function acknowledgeIncident(incidentId: string): Promise<Incident> {
  return gql<{ acknowledgeIncident: Incident }>(ACKNOWLEDGE_MUTATION, { incidentId }).then((data) => data.acknowledgeIncident);
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
    queryFn: ({ signal }) => gql<{ discoveryNodes: DiscoveryNode[] }>(DISCOVERY_NODES_QUERY, undefined, signal),
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
      gql<{ discoveryJobs: DiscoveryJob[] }>(DISCOVERY_JOBS_QUERY, { status, first: CONSOLE.discoveryJobsLimit }, signal),
    select: (data) => data.discoveryJobs,
    refetchInterval: CONSOLE.livePollMs,
  });
}

const CURRENT_SWEEP_QUERY = ['query CurrentSweep {', '  currentSweep { ' + SWEEP_FIELDS + ' }', '}'].join('\n');

export function currentSweepQuery() {
  return queryOptions({
    queryKey: ['current-sweep'] as const,
    queryFn: ({ signal }) => gql<{ currentSweep: Sweep | null }>(CURRENT_SWEEP_QUERY, undefined, signal),
    select: (data) => data.currentSweep,
    refetchInterval: CONSOLE.livePollMs,
  });
}

const RUN_DISCOVERY_MUTATION = [
  'mutation RunDiscovery($collectorIds: [String!], $siteId: UUID) {',
  '  runDiscovery(collectorIds: $collectorIds, siteId: $siteId) { ' + SWEEP_FIELDS + ' }',
  '}',
].join('\n');

export function runDiscovery(collectorIds: string[] | null = null, siteId: string | null = null): Promise<Sweep> {
  return gql<{ runDiscovery: Sweep }>(RUN_DISCOVERY_MUTATION, { collectorIds, siteId }).then((data) => data.runDiscovery);
}
