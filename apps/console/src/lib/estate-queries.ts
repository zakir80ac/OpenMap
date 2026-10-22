// REQ-UI-009 REQ-UI-010 REQ-UI-011 REQ-UI-014 REQ-UI-017 REQ-UI-018 — GraphQL operations behind the assets, IPAM, DCIM,
// integrations, analytics and assistant screens. Same conventions as queries.ts: TanStack Query options for reads,
// plain async functions for mutations, every field list spelled once.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { CONSOLE } from '@openmap/constants';
import type { CiLayer } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiRef, type CiSummary } from './queries';

// ---------------------------------------------------------------------------------------------------------------
// Assets — REQ-UI-009
// ---------------------------------------------------------------------------------------------------------------

export type AssetStage = 'planned' | 'in_stock' | 'deployed' | 'spare' | 'rma' | 'retired' | 'disposed';
export type PlanStatus = 'draft' | 'approved' | 'building' | 'live' | 'cancelled';
export const ASSET_STAGES: readonly AssetStage[] = ['planned', 'in_stock', 'deployed', 'spare', 'rma', 'retired', 'disposed'];
export const PLAN_STATUSES: readonly PlanStatus[] = ['draft', 'approved', 'building', 'live', 'cancelled'];

export interface Money {
  amount: number;
  currency: string;
}

export interface VendorContact {
  id: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  portalUrl: string | null;
}

export interface SupportContract {
  id: string;
  vendor: CiRef;
  contractNumber: string;
  level: string;
  endsAt: string;
  primaryContact: VendorContact | null;
}

export interface AssetRecord {
  id: string;
  ci: CiSummary | null;
  assetTag: string;
  serialNumber: string | null;
  manufacturer: string;
  model: string;
  stage: AssetStage;
  warrantyEndsAt: string | null;
  supportContract: SupportContract | null;
  endOfSupport: string | null;
  plan: { id: string; number: string; name: string; status: PlanStatus } | null;
  purchaseCost: Money | null;
}

export interface BomLine {
  description: string;
  manufacturer: string | null;
  model: string | null;
  sku: string | null;
  layer: CiLayer;
  quantity: number;
  received: number;
  unitCost: Money | null;
}

export interface InfraPlan {
  id: string;
  number: string;
  name: string;
  kind: string;
  status: PlanStatus;
  bom: BomLine[];
  estimatedCost: Money | null;
  targetSite: CiRef | null;
  targetRacks: CiRef[];
  plannedLiveAt: string | null;
  assets: Array<{ id: string; assetTag: string; stage: AssetStage }>;
}

export interface BomLineInput {
  description: string;
  manufacturer?: string;
  model?: string;
  sku?: string;
  layer: CiLayer;
  quantity: number;
  unitCostAmount?: number;
  unitCostCurrency?: string;
}

export interface PlanInput {
  name: string;
  description: string;
  kind: string;
  targetSiteId?: string;
  targetRackIds?: string[];
  bom: BomLineInput[];
  plannedLiveAt?: string;
}

const MONEY_FIELDS = '{ amount currency }';
const ASSET_FIELDS = [
  'id assetTag serialNumber manufacturer model stage warrantyEndsAt endOfSupport',
  'ci { ' + CI_SUMMARY_FIELDS + ' }',
  'supportContract { id contractNumber level endsAt vendor { id displayName } primaryContact { id name role email phone portalUrl } }',
  'plan { id number name status }',
  'purchaseCost ' + MONEY_FIELDS,
].join(' ');
const PLAN_FIELDS = [
  'id number name kind status plannedLiveAt',
  'bom { description manufacturer model sku layer quantity received unitCost ' + MONEY_FIELDS + ' }',
  'estimatedCost ' + MONEY_FIELDS,
  'targetSite { id displayName } targetRacks { id displayName }',
  'assets { id assetTag stage }',
].join(' ');

const ASSETS_QUERY = 'query Assets($stage: [AssetStage!], $warrantyExpiringWithinDays: Int, $first: Int) { assets(stage: $stage, warrantyExpiringWithinDays: $warrantyExpiringWithinDays, first: $first) { ' + ASSET_FIELDS + ' } }';
const PLANS_QUERY = 'query Plans($status: [PlanStatus!]) { plans(status: $status) { ' + PLAN_FIELDS + ' } }';
const CREATE_PLAN_MUTATION = 'mutation CreatePlan($input: PlanInput!) { createPlan(input: $input) { ' + PLAN_FIELDS + ' } }';
const SET_PLAN_STATUS_MUTATION = 'mutation SetPlanStatus($planId: UUID!, $status: PlanStatus!) { setPlanStatus(planId: $planId, status: $status) { ' + PLAN_FIELDS + ' } }';
const SET_ASSET_STAGE_MUTATION = 'mutation SetAssetStage($assetId: UUID!, $stage: AssetStage!, $note: String) { setAssetStage(assetId: $assetId, stage: $stage, note: $note) { ' + ASSET_FIELDS + ' } }';

export interface AssetsFilter {
  stage?: AssetStage[] | null;
  warrantyExpiringWithinDays?: number | null;
}

export function assetsQuery(filter: AssetsFilter, first: number = CONSOLE.explorerPageSize) {
  return queryOptions({
    queryKey: ['assets', filter, first] as const,
    queryFn: ({ signal }) => gql<{ assets: AssetRecord[] }>(ASSETS_QUERY, { stage: filter.stage ?? null, warrantyExpiringWithinDays: filter.warrantyExpiringWithinDays ?? null, first }, signal).then((d) => d.assets),
  });
}

export function plansQuery(status?: PlanStatus[] | null) {
  return queryOptions({
    queryKey: ['plans', status ?? null] as const,
    queryFn: ({ signal }) => gql<{ plans: InfraPlan[] }>(PLANS_QUERY, { status: status ?? null }, signal).then((d) => d.plans),
  });
}

export function createPlan(input: PlanInput): Promise<InfraPlan> {
  return gql<{ createPlan: InfraPlan }>(CREATE_PLAN_MUTATION, { input }).then((d) => d.createPlan);
}

export function setPlanStatus(planId: string, status: PlanStatus): Promise<InfraPlan> {
  return gql<{ setPlanStatus: InfraPlan }>(SET_PLAN_STATUS_MUTATION, { planId, status }).then((d) => d.setPlanStatus);
}

export function setAssetStage(assetId: string, stage: AssetStage, note?: string): Promise<AssetRecord> {
  return gql<{ setAssetStage: AssetRecord }>(SET_ASSET_STAGE_MUTATION, { assetId, stage, note: note ?? null }).then((d) => d.setAssetStage);
}

// ---------------------------------------------------------------------------------------------------------------
// IPAM — REQ-UI-010
// ---------------------------------------------------------------------------------------------------------------

export interface SubnetNode {
  ci: CiSummary;
  cidr: string;
  vrf: string | null;
  utilisationPercent: number;
  children: SubnetNode[];
}

export interface AttributedCi extends CiSummary {
  identity: Record<string, string>;
  attributes: Record<string, unknown>;
}

export interface AttributedCiPage {
  edges: Array<{ cursor: string; node: AttributedCi }>;
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
  totalCount: number;
}

const SUBNET_FIELDS = 'cidr vrf utilisationPercent ci { ' + CI_SUMMARY_FIELDS + ' }';
/** Four levels of the tree in one round trip: supernets, their subnets, and two levels within those. */
const SUBNETS_QUERY = 'query Subnets { subnets { ' + SUBNET_FIELDS + ' children { ' + SUBNET_FIELDS + ' children { ' + SUBNET_FIELDS + ' children { ' + SUBNET_FIELDS + ' } } } } }';
const CIS_BY_ATTRIBUTE_QUERY = [
  'query CisByAttribute($types: [String!], $attributeEquals: JSON, $text: String, $first: Int, $after: String) {',
  '  cis(filter: { types: $types, attributeEquals: $attributeEquals, text: $text }, first: $first, after: $after) {',
  '    edges { cursor node { ' + CI_SUMMARY_FIELDS + ' identity attributes } }',
  '    pageInfo { endCursor hasNextPage }',
  '    totalCount',
  '  }',
  '}',
].join('\n');
const NEXT_FREE_IP_QUERY = 'query NextFreeIp($subnetId: UUID!) { nextFreeIp(subnetId: $subnetId) }';

export function subnetsQuery() {
  return queryOptions({
    queryKey: ['subnets'] as const,
    queryFn: ({ signal }) => gql<{ subnets: SubnetNode[] }>(SUBNETS_QUERY, {}, signal).then((d) => d.subnets),
  });
}

/** CIs of the given types matching attribute values and/or text: addresses of a subnet, records of a zone, leases of a scope. */
export function cisByAttributeInfiniteQuery(types: string[], attributeEquals: Record<string, unknown> | null, text: string | null = null, first: number = CONSOLE.explorerPageSize) {
  return infiniteQueryOptions({
    queryKey: ['cisByAttribute', types, attributeEquals, text, first] as const,
    queryFn: ({ pageParam, signal }) => gql<{ cis: AttributedCiPage }>(CIS_BY_ATTRIBUTE_QUERY, { types, attributeEquals, text, first, after: pageParam }, signal).then((d) => d.cis),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? last.pageInfo.endCursor : null),
  });
}

export function nextFreeIpQuery(subnetId: string) {
  return queryOptions({
    queryKey: ['nextFreeIp', subnetId] as const,
    queryFn: ({ signal }) => gql<{ nextFreeIp: string | null }>(NEXT_FREE_IP_QUERY, { subnetId }, signal).then((d) => d.nextFreeIp),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// DCIM — REQ-UI-011
// ---------------------------------------------------------------------------------------------------------------

export interface RackDevice {
  ci: CiSummary;
  startUnit: number;
  heightUnits: number;
  face: string;
}

export interface PowerFeed {
  ci: CiSummary;
  ratedWatts: number;
  currentWatts: number;
}

export interface Rack {
  ci: CiSummary & { attributes: Record<string, unknown> };
  units: number;
  occupiedUnits: number;
  devices: RackDevice[];
  powerFeeds: PowerFeed[];
  row: CiRef | null;
  room: (CiRef & { attributes: Record<string, unknown> }) | null;
}

const RACKS_QUERY = [
  'query Racks($roomId: UUID) {',
  '  racks(roomId: $roomId) {',
  '    ci { ' + CI_SUMMARY_FIELDS + ' attributes }',
  '    units occupiedUnits',
  '    devices { startUnit heightUnits face ci { ' + CI_SUMMARY_FIELDS + ' } }',
  '    powerFeeds { ratedWatts currentWatts ci { ' + CI_SUMMARY_FIELDS + ' } }',
  '    row { id displayName }',
  '    room { id displayName attributes }',
  '  }',
  '}',
].join('\n');

export function racksQuery(roomId?: string | null) {
  return queryOptions({
    queryKey: ['racks', roomId ?? null] as const,
    queryFn: ({ signal }) => gql<{ racks: Rack[] }>(RACKS_QUERY, { roomId: roomId ?? null }, signal).then((d) => d.racks),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Integrations — REQ-UI-014
// ---------------------------------------------------------------------------------------------------------------

export type IntegrationHealth = 'healthy' | 'warning' | 'failing' | 'disabled';

export interface Integration {
  id: string;
  category: string;
  vendor: string;
  name: string;
  enabled: boolean;
  direction: string;
  health: IntegrationHealth;
  lastSuccessAt: string | null;
  lastError: string | null;
  deliveredLastHour: number;
  failedLastHour: number;
}

export interface FieldMapping {
  from: string;
  to: string;
  direction: string;
}

export interface ClassMapping {
  ciType: string;
  remoteClass: string;
}

export interface IntegrationDetail extends Integration {
  endpoint: string;
  credentialRef: string;
  settings: Record<string, unknown>;
  fieldMappings: FieldMapping[];
  classMappings: ClassMapping[];
  subscribedEvents: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationDelivery {
  id: string;
  direction: string;
  eventId: string | null;
  remoteId: string | null;
  state: string;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface IntegrationInput {
  category: string;
  vendor: string;
  name: string;
  endpoint: string;
  credentialRef: string;
  direction: string;
  settings?: Record<string, unknown>;
  fieldMappings?: FieldMapping[];
  classMappings?: ClassMapping[];
  subscribedEvents?: string[];
}

const INTEGRATION_FIELDS = 'id category vendor name enabled direction health lastSuccessAt lastError deliveredLastHour failedLastHour';
const INTEGRATION_DETAIL_FIELDS = INTEGRATION_FIELDS + ' endpoint credentialRef settings fieldMappings classMappings subscribedEvents createdAt updatedAt';
const INTEGRATIONS_QUERY = 'query Integrations($category: String) { integrations(category: $category) { ' + INTEGRATION_FIELDS + ' } }';
const INTEGRATION_QUERY = 'query Integration($id: UUID!) { integration(id: $id) { ' + INTEGRATION_DETAIL_FIELDS + ' } }';
const INTEGRATION_DELIVERIES_QUERY = 'query IntegrationDeliveries($integrationId: UUID!, $first: Int) { integrationDeliveries(integrationId: $integrationId, first: $first) { id direction eventId remoteId state attempts responseCode error createdAt completedAt } }';
const UPSERT_INTEGRATION_MUTATION = 'mutation UpsertIntegration($id: UUID, $input: IntegrationInput!) { upsertIntegration(id: $id, input: $input) { ' + INTEGRATION_FIELDS + ' } }';
const TEST_INTEGRATION_MUTATION = 'mutation TestIntegration($id: UUID!) { testIntegration(id: $id) { ' + INTEGRATION_FIELDS + ' } }';

export function integrationsQuery(category?: string | null) {
  return queryOptions({
    queryKey: ['integrations', category ?? null] as const,
    queryFn: ({ signal }) => gql<{ integrations: Integration[] }>(INTEGRATIONS_QUERY, { category: category ?? null }, signal).then((d) => d.integrations),
  });
}

export function integrationQuery(id: string) {
  return queryOptions({
    queryKey: ['integration', id] as const,
    queryFn: ({ signal }) => gql<{ integration: IntegrationDetail }>(INTEGRATION_QUERY, { id }, signal).then((d) => d.integration),
  });
}

export function integrationDeliveriesQuery(integrationId: string, first: number = CONSOLE.explorerPageSize) {
  return queryOptions({
    queryKey: ['integrationDeliveries', integrationId, first] as const,
    queryFn: ({ signal }) => gql<{ integrationDeliveries: IntegrationDelivery[] }>(INTEGRATION_DELIVERIES_QUERY, { integrationId, first }, signal).then((d) => d.integrationDeliveries),
  });
}

export function upsertIntegration(id: string | null, input: IntegrationInput): Promise<Integration> {
  return gql<{ upsertIntegration: Integration }>(UPSERT_INTEGRATION_MUTATION, { id, input }).then((d) => d.upsertIntegration);
}

export function testIntegration(id: string): Promise<Integration> {
  return gql<{ testIntegration: Integration }>(TEST_INTEGRATION_MUTATION, { id }).then((d) => d.testIntegration);
}

// ---------------------------------------------------------------------------------------------------------------
// Analytics and assistant — REQ-UI-017 REQ-UI-018
// ---------------------------------------------------------------------------------------------------------------

export interface AnalyticsEmbed {
  supersetUrl: string;
  dashboardId: string;
  token: string;
  expiresInSeconds: number;
}

export interface AssistantAnswer {
  text: string;
  cypher: string;
  rows: Array<Record<string, unknown>>;
  cis: CiSummary[];
}

const ANALYTICS_EMBED_QUERY = 'query AnalyticsEmbed { analyticsEmbed { supersetUrl dashboardId token expiresInSeconds } }';
const ASK_ASSISTANT_MUTATION = 'mutation AskAssistant($question: String!) { askAssistant(question: $question) { text cypher rows cis { ' + CI_SUMMARY_FIELDS + ' } } }';

/** One embed handshake per mount; the SDK asks again through fetchAnalyticsEmbed before the token expires. */
export function analyticsEmbedQuery() {
  return queryOptions({
    queryKey: ['analyticsEmbed'] as const,
    queryFn: ({ signal }) => gql<{ analyticsEmbed: AnalyticsEmbed }>(ANALYTICS_EMBED_QUERY, {}, signal).then((d) => d.analyticsEmbed),
    staleTime: 0,
    gcTime: 0,
  });
}

export function fetchAnalyticsEmbed(): Promise<AnalyticsEmbed> {
  return gql<{ analyticsEmbed: AnalyticsEmbed }>(ANALYTICS_EMBED_QUERY, {}).then((d) => d.analyticsEmbed);
}

export function askAssistant(question: string): Promise<AssistantAnswer> {
  return gql<{ askAssistant: AssistantAnswer }>(ASK_ASSISTANT_MUTATION, { question }).then((d) => d.askAssistant);
}
