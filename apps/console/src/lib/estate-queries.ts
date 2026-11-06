// REQ-UI-009 REQ-UI-010 REQ-UI-011 REQ-UI-014 REQ-UI-017 REQ-UI-018 REQ-CMDB-039 REQ-CMDB-040 — GraphQL operations behind the assets, IPAM, DCIM,
// integrations, analytics and assistant screens. Same conventions as queries.ts: TanStack Query options for reads,
// plain async functions for mutations, every field list spelled once.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { ASSETS, CONSOLE, type Locale } from '@openmap/constants';
import type { AssetDataGap, CiLayer, DepreciationMethod } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiRef, type CiSummary, type JsonValue } from './queries';

// ---------------------------------------------------------------------------------------------------------------
// Assets — REQ-UI-009
// ---------------------------------------------------------------------------------------------------------------

export type AssetStage = 'planned' | 'in_stock' | 'deployed' | 'spare' | 'rma' | 'retired' | 'disposed';
export type PlanStatus = 'draft' | 'approved' | 'building' | 'live' | 'cancelled';
export const ASSET_STAGES: readonly AssetStage[] = [
  'planned',
  'in_stock',
  'deployed',
  'spare',
  'rma',
  'retired',
  'disposed',
];
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

export type AssetSource = 'plan' | 'discovery' | 'manual';
export type { AssetDataGap };
/** The contract's list, re-exported so views keep one import; ADR-027 added `subscription`. */
export { ASSET_DATA_GAPS } from '@openmap/contracts';

export interface Warranty {
  provider: string;
  level: string | null;
  startsAt: string | null;
  endsAt: string;
  source: string;
  verifiedAt: string | null;
}
/** REQ-CMDB-042 (ADR-027) — prepaid credits of a cloud or SaaS subscription as the vendor reported them. */
export interface Credits {
  remaining: number;
  unit: string;
  currency: string | null;
  asOf: string;
}
export interface SubscriptionCover {
  provider: string;
  plan: string | null;
  startsAt: string | null;
  endsAt: string | null;
  credits: Credits | null;
  source: string;
  verifiedAt: string | null;
}
export interface Support {
  provider: string;
  contractNumber: string | null;
  level: string | null;
  endsAt: string;
  source: string;
  verifiedAt: string | null;
}
export interface EndOfLife {
  endOfSale: string | null;
  endOfSoftwareMaintenance: string | null;
  endOfSupport: string | null;
  source: string;
  verifiedAt: string | null;
}
export interface AssetAudit {
  id: string;
  actor: string;
  at: string;
  field: string;
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
}

/** REQ-CMDB-039 (ADR-023) — a register row: an owned CI, a planned BOM unit or a manual entry, with its cover dates. */
export interface AssetRecord {
  id: string;
  ci: CiSummary | null;
  ciType: string | null;
  layer: CiLayer;
  source: AssetSource;
  assetTag: string;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  partNumber: string | null;
  stage: AssetStage;
  custodian: string | null;
  purchasedAt: string | null;
  warranty: Warranty | null;
  warrantyEndsAt: string | null;
  subscription: SubscriptionCover | null;
  subscriptionEndsAt: string | null;
  creditsRemaining: number | null;
  support: Support | null;
  supportContract: SupportContract | null;
  supportEndsAt: string | null;
  endOfLife: EndOfLife | null;
  endOfSupport: string | null;
  dataGaps: AssetDataGap[];
  plan: { id: string; number: string; name: string; status: PlanStatus } | null;
  purchaseCost: Money | null;
  /** REQ-CMDB-017: the schedule and today's value under it (null without a purchase cost and date). */
  depreciation: { method: DepreciationMethod; usefulLifeMonths: number; residualValue: Money };
  bookValue: Money | null;
  /** REQ-CMDB-019: stock control of a stocked spare. */
  stock: { onHand: number; reorderPoint: number; belowReorderPoint: boolean } | null;
}

export interface AssetSummary {
  layer: CiLayer;
  count: number;
  needsData: number;
  warrantyExpired: number;
  subscriptionExpired: number;
  supportExpired: number;
  endOfSupportPassed: number;
  belowReorderPoint: number;
}

/** Fields a person records on an asset; an omitted field is left alone, null clears it. */
export interface AssetDetailsInput {
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  partNumber?: string | null;
  custodian?: string | null;
  purchasedAt?: string | null;
  purchaseCostAmount?: number | null;
  purchaseCostCurrency?: string | null;
  warranty?: { provider: string; level?: string | null; startsAt?: string | null; endsAt: string } | null;
  subscription?: {
    provider: string;
    plan?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    creditsRemaining?: number | null;
    creditsUnit?: string | null;
    creditsCurrency?: string | null;
  } | null;
  support?: {
    provider: string;
    contractNumber?: string | null;
    level?: string | null;
    endsAt: string;
  } | null;
  endOfLife?: {
    endOfSale?: string | null;
    endOfSoftwareMaintenance?: string | null;
    endOfSupport?: string | null;
  } | null;
  depreciation?: { method: DepreciationMethod; usefulLifeMonths: number; residualValueAmount: number } | null;
  stock?: { onHand: number; reorderPoint: number } | null;
  note?: string | null;
}

export interface ManualAssetInput {
  layer: CiLayer;
  type: string;
  name: string;
  assetTag?: string | null;
  locationCiId?: string | null;
  details: AssetDetailsInput;
}

export interface BomLine {
  /** Position in the plan's BOM, from 0; receiving names a line by it (ADR-034). */
  position: number;
  description: string;
  manufacturer: string | null;
  model: string | null;
  sku: string | null;
  layer: CiLayer;
  quantity: number;
  received: number;
  outstanding: number;
  unitCost: Money | null;
}

/** REQ-CMDB-020 (ADR-034): one delivery against a BOM line. */
export interface PlanReceipt {
  id: string;
  position: number;
  description: string;
  quantity: number;
  receivedOn: string;
  receivedBy: string;
  reference: string | null;
  location: CiRef | null;
  assets: Array<{ id: string; assetTag: string; serialNumber: string | null }>;
}

export interface ReceivedUnitInput {
  serialNumber: string;
  assetTag: string | null;
}

export interface ReceiptInput {
  planId: string;
  position: number;
  /** Calendar date (YYYY-MM-DD). */
  receivedOn: string;
  reference?: string;
  locationId?: string;
  units: ReceivedUnitInput[];
}

export interface InfraPlan {
  id: string;
  number: string;
  name: string;
  description: string;
  kind: string;
  status: PlanStatus;
  owner: string;
  bom: BomLine[];
  estimatedCost: Money | null;
  targetSite: CiRef | null;
  targetRacks: CiRef[];
  plannedLiveAt: string | null;
  assets: Array<{ id: string; assetTag: string; stage: AssetStage }>;
  receipts: PlanReceipt[];
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
const COVER_FIELDS =
  'warranty { provider level startsAt endsAt source verifiedAt } subscription { provider plan startsAt endsAt credits { remaining unit currency asOf } source verifiedAt } support { provider contractNumber level endsAt source verifiedAt } endOfLife { endOfSale endOfSoftwareMaintenance endOfSupport source verifiedAt }';
const ASSET_FIELDS = [
  'id ciType layer source assetTag serialNumber manufacturer model partNumber stage custodian purchasedAt warrantyEndsAt subscriptionEndsAt creditsRemaining supportEndsAt endOfSupport dataGaps',
  COVER_FIELDS,
  'ci { ' + CI_SUMMARY_FIELDS + ' }',
  'supportContract { id contractNumber level endsAt vendor { id displayName } primaryContact { id name role email phone portalUrl } }',
  'plan { id number name status }',
  'purchaseCost ' + MONEY_FIELDS,
  'depreciation { method usefulLifeMonths residualValue ' + MONEY_FIELDS + ' }',
  'bookValue ' + MONEY_FIELDS,
  'stock { onHand reorderPoint belowReorderPoint }',
].join(' ');
const RECEIPT_FIELDS =
  'id position description quantity receivedOn receivedBy reference location { id displayName } assets { id assetTag serialNumber }';
const PLAN_FIELDS = [
  'id number name description owner kind status plannedLiveAt',
  'bom { position description manufacturer model sku layer quantity received outstanding unitCost ' + MONEY_FIELDS + ' }',
  'estimatedCost ' + MONEY_FIELDS,
  'targetSite { id displayName } targetRacks { id displayName }',
  'assets { id assetTag stage }',
  'receipts { ' + RECEIPT_FIELDS + ' }',
].join(' ');

const ASSETS_QUERY =
  'query Assets($filter: AssetFilter, $stage: [AssetStage!], $warrantyExpiringWithinDays: Int, $first: Int, $after: String) { assets(filter: $filter, stage: $stage, warrantyExpiringWithinDays: $warrantyExpiringWithinDays, first: $first, after: $after) { ' +
  ASSET_FIELDS +
  ' } }';
const ASSET_SUMMARY_QUERY =
  'query AssetSummary { assetSummary { layer count needsData warrantyExpired subscriptionExpired supportExpired endOfSupportPassed belowReorderPoint } }';
const ASSET_AUDITS_QUERY =
  'query AssetAudits($filter: AssetFilter) { assets(filter: $filter, first: 1) { id audits { id actor at field fromValue toValue note } } }';
const UPDATE_ASSET_MUTATION =
  'mutation UpdateAsset($assetId: UUID!, $input: AssetDetailsInput!) { updateAsset(assetId: $assetId, input: $input) { ' +
  ASSET_FIELDS +
  ' } }';
const CREATE_ASSET_MUTATION =
  'mutation CreateAsset($input: ManualAssetInput!) { createAsset(input: $input) { ' + ASSET_FIELDS + ' } }';
const UNKNOWN_CIS_QUERY =
  'query UnknownCis($first: Int) { unknownCis(first: $first) { totalCount edges { node { ' +
  CI_SUMMARY_FIELDS +
  ' attributes observedAt } } } }';
const PLANS_QUERY = 'query Plans($status: [PlanStatus!]) { plans(status: $status) { ' + PLAN_FIELDS + ' } }';
const CREATE_PLAN_MUTATION =
  'mutation CreatePlan($input: PlanInput!) { createPlan(input: $input) { ' + PLAN_FIELDS + ' } }';
const SET_PLAN_STATUS_MUTATION =
  'mutation SetPlanStatus($planId: UUID!, $status: PlanStatus!) { setPlanStatus(planId: $planId, status: $status) { ' +
  PLAN_FIELDS +
  ' } }';
const RECEIVE_PLAN_LINE_MUTATION =
  'mutation ReceivePlanLine($input: ReceiptInput!) { receivePlanLine(input: $input) { ' + RECEIPT_FIELDS + ' } }';
const SET_ASSET_STAGE_MUTATION =
  'mutation SetAssetStage($assetId: UUID!, $stage: AssetStage!, $note: String) { setAssetStage(assetId: $assetId, stage: $stage, note: $note) { ' +
  ASSET_FIELDS +
  ' } }';

export interface AssetsFilter {
  stage?: AssetStage[] | null;
  warrantyExpiringWithinDays?: number | null;
  layers?: CiLayer[] | null;
  types?: string[] | null;
  sources?: AssetSource[] | null;
  dataGaps?: AssetDataGap[] | null;
  text?: string | null;
  /** REQ-CMDB-019: only stocked spares at or below their reorder point. */
  belowReorderPoint?: boolean | null;
}

function filterVariables(filter: AssetsFilter): Record<string, unknown> {
  const register = filter.layers || filter.types || filter.sources || filter.dataGaps || filter.text || filter.belowReorderPoint;
  return {
    filter: register
      ? {
          layers: filter.layers ?? null,
          types: filter.types ?? null,
          stages: filter.stage ?? null,
          sources: filter.sources ?? null,
          dataGaps: filter.dataGaps ?? null,
          text: filter.text ?? null,
          warrantyExpiringWithinDays: filter.warrantyExpiringWithinDays ?? null,
          belowReorderPoint: filter.belowReorderPoint ?? null,
        }
      : null,
    stage: filter.stage ?? null,
    warrantyExpiringWithinDays: filter.warrantyExpiringWithinDays ?? null,
  };
}

export function assetsQuery(filter: AssetsFilter, first: number = CONSOLE.explorerPageSize) {
  return queryOptions({
    queryKey: ['assets', filter, first] as const,
    queryFn: ({ signal }) =>
      gql<{ assets: AssetRecord[] }>(ASSETS_QUERY, { ...filterVariables(filter), first }, signal).then(
        (d) => d.assets,
      ),
  });
}

/** base64url of a UTF-8 string: the encoding the API's cursors use (REQ-CORE-012). */
function base64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
}

/** The register page after the last row seen: the API's id cursor is the base64url of `{ id }`. */
export function assetsAfter(
  filter: AssetsFilter,
  afterId: string,
  first: number = CONSOLE.explorerPageSize,
): Promise<AssetRecord[]> {
  const after = base64Url(JSON.stringify({ id: afterId }));
  return gql<{ assets: AssetRecord[] }>(ASSETS_QUERY, { ...filterVariables(filter), first, after }).then(
    (d) => d.assets,
  );
}

export interface AssetPage {
  items: AssetRecord[];
  totalCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const ASSET_PAGE_QUERY =
  'query AssetPage($filter: AssetFilter, $page: Int, $pageSize: Int) { assetPage(filter: $filter, page: $page, pageSize: $pageSize) { items { ' +
  ASSET_FIELDS +
  ' } totalCount page pageSize pageCount } }';

/** REQ-CMDB-041 — the register page by number with its totals. */
export function assetPageQuery(
  filter: AssetsFilter,
  page: number,
  pageSize: number = ASSETS.registerPageSize,
) {
  return queryOptions({
    queryKey: ['assets', 'page', filter, page, pageSize] as const,
    queryFn: ({ signal }) =>
      gql<{ assetPage: AssetPage }>(
        ASSET_PAGE_QUERY,
        { ...filterVariables(filter), page, pageSize },
        signal,
      ).then((d) => d.assetPage),
  });
}

export function assetSummaryQuery() {
  return queryOptions({
    queryKey: ['assetSummary'] as const,
    queryFn: ({ signal }) =>
      gql<{ assetSummary: AssetSummary[] }>(ASSET_SUMMARY_QUERY, {}, signal).then((d) => d.assetSummary),
  });
}

export function assetAuditsQuery(assetTag: string) {
  return queryOptions({
    queryKey: ['assetAudits', assetTag] as const,
    queryFn: ({ signal }) =>
      gql<{ assets: Array<{ id: string; audits: AssetAudit[] }> }>(
        ASSET_AUDITS_QUERY,
        { filter: { text: assetTag } },
        signal,
      ).then((d) => d.assets[0]?.audits ?? []),
  });
}

export function updateAsset(assetId: string, input: AssetDetailsInput): Promise<AssetRecord> {
  return gql<{ updateAsset: AssetRecord }>(UPDATE_ASSET_MUTATION, { assetId, input }).then(
    (d) => d.updateAsset,
  );
}

export function createAsset(input: ManualAssetInput): Promise<AssetRecord> {
  return gql<{ createAsset: AssetRecord }>(CREATE_ASSET_MUTATION, { input }).then((d) => d.createAsset);
}

/** REQ-CMDB-040 — the unknown layer's CIs with the attributes the scanners recorded, for diagnosis and labelling. */
export interface UnknownCi extends CiSummary {
  attributes: Record<string, JsonValue>;
  observedAt: string;
}

export function unknownCisQuery(first: number = ASSETS.unknownPageSize) {
  return queryOptions({
    queryKey: ['unknownCis', first] as const,
    queryFn: ({ signal }) =>
      gql<{ unknownCis: { totalCount: number; edges: Array<{ node: UnknownCi }> } }>(
        UNKNOWN_CIS_QUERY,
        { first },
        signal,
      ).then((d) => ({ total: d.unknownCis.totalCount, items: d.unknownCis.edges.map((e) => e.node) })),
  });
}

export function plansQuery(status?: PlanStatus[] | null) {
  return queryOptions({
    queryKey: ['plans', status ?? null] as const,
    queryFn: ({ signal }) =>
      gql<{ plans: InfraPlan[] }>(PLANS_QUERY, { status: status ?? null }, signal).then((d) => d.plans),
  });
}

export function createPlan(input: PlanInput): Promise<InfraPlan> {
  return gql<{ createPlan: InfraPlan }>(CREATE_PLAN_MUTATION, { input }).then((d) => d.createPlan);
}

export function setPlanStatus(planId: string, status: PlanStatus): Promise<InfraPlan> {
  return gql<{ setPlanStatus: InfraPlan }>(SET_PLAN_STATUS_MUTATION, { planId, status }).then(
    (d) => d.setPlanStatus,
  );
}

/** REQ-CMDB-020 — takes units of one BOM line into stock (ADR-034). */
export function receivePlanLine(input: ReceiptInput): Promise<PlanReceipt> {
  return gql<{ receivePlanLine: PlanReceipt }>(RECEIVE_PLAN_LINE_MUTATION, { input }).then((d) => d.receivePlanLine);
}

export function setAssetStage(assetId: string, stage: AssetStage, note?: string): Promise<AssetRecord> {
  return gql<{ setAssetStage: AssetRecord }>(SET_ASSET_STAGE_MUTATION, {
    assetId,
    stage,
    note: note ?? null,
  }).then((d) => d.setAssetStage);
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
const SUBNETS_QUERY =
  'query Subnets { subnets { ' +
  SUBNET_FIELDS +
  ' children { ' +
  SUBNET_FIELDS +
  ' children { ' +
  SUBNET_FIELDS +
  ' children { ' +
  SUBNET_FIELDS +
  ' } } } } }';
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
export function cisByAttributeInfiniteQuery(
  types: string[],
  attributeEquals: Record<string, unknown> | null,
  text: string | null = null,
  first: number = CONSOLE.explorerPageSize,
) {
  return infiniteQueryOptions({
    queryKey: ['cisByAttribute', types, attributeEquals, text, first] as const,
    queryFn: ({ pageParam, signal }) =>
      gql<{ cis: AttributedCiPage }>(
        CIS_BY_ATTRIBUTE_QUERY,
        { types, attributeEquals, text, first, after: pageParam },
        signal,
      ).then((d) => d.cis),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pageInfo.hasNextPage ? last.pageInfo.endCursor : null),
  });
}

export function nextFreeIpQuery(subnetId: string) {
  return queryOptions({
    queryKey: ['nextFreeIp', subnetId] as const,
    queryFn: ({ signal }) =>
      gql<{ nextFreeIp: string | null }>(NEXT_FREE_IP_QUERY, { subnetId }, signal).then((d) => d.nextFreeIp),
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
    queryFn: ({ signal }) =>
      gql<{ racks: Rack[] }>(RACKS_QUERY, { roomId: roomId ?? null }, signal).then((d) => d.racks),
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

const INTEGRATION_FIELDS =
  'id category vendor name enabled direction health lastSuccessAt lastError deliveredLastHour failedLastHour';
const INTEGRATION_DETAIL_FIELDS =
  INTEGRATION_FIELDS +
  ' endpoint credentialRef settings fieldMappings classMappings subscribedEvents createdAt updatedAt';
const INTEGRATIONS_QUERY =
  'query Integrations($category: String) { integrations(category: $category) { ' +
  INTEGRATION_FIELDS +
  ' } }';
const INTEGRATION_QUERY =
  'query Integration($id: UUID!) { integration(id: $id) { ' + INTEGRATION_DETAIL_FIELDS + ' } }';
const INTEGRATION_DELIVERIES_QUERY =
  'query IntegrationDeliveries($integrationId: UUID!, $first: Int) { integrationDeliveries(integrationId: $integrationId, first: $first) { id direction eventId remoteId state attempts responseCode error createdAt completedAt } }';
const UPSERT_INTEGRATION_MUTATION =
  'mutation UpsertIntegration($id: UUID, $input: IntegrationInput!) { upsertIntegration(id: $id, input: $input) { ' +
  INTEGRATION_FIELDS +
  ' } }';
const TEST_INTEGRATION_MUTATION =
  'mutation TestIntegration($id: UUID!) { testIntegration(id: $id) { ' + INTEGRATION_FIELDS + ' } }';

export function integrationsQuery(category?: string | null) {
  return queryOptions({
    queryKey: ['integrations', category ?? null] as const,
    queryFn: ({ signal }) =>
      gql<{ integrations: Integration[] }>(INTEGRATIONS_QUERY, { category: category ?? null }, signal).then(
        (d) => d.integrations,
      ),
  });
}

export function integrationQuery(id: string) {
  return queryOptions({
    queryKey: ['integration', id] as const,
    queryFn: ({ signal }) =>
      gql<{ integration: IntegrationDetail }>(INTEGRATION_QUERY, { id }, signal).then((d) => d.integration),
  });
}

export function integrationDeliveriesQuery(integrationId: string, first: number = CONSOLE.explorerPageSize) {
  return queryOptions({
    queryKey: ['integrationDeliveries', integrationId, first] as const,
    queryFn: ({ signal }) =>
      gql<{ integrationDeliveries: IntegrationDelivery[] }>(
        INTEGRATION_DELIVERIES_QUERY,
        { integrationId, first },
        signal,
      ).then((d) => d.integrationDeliveries),
  });
}

export function upsertIntegration(id: string | null, input: IntegrationInput): Promise<Integration> {
  return gql<{ upsertIntegration: Integration }>(UPSERT_INTEGRATION_MUTATION, { id, input }).then(
    (d) => d.upsertIntegration,
  );
}

export function testIntegration(id: string): Promise<Integration> {
  return gql<{ testIntegration: Integration }>(TEST_INTEGRATION_MUTATION, { id }).then(
    (d) => d.testIntegration,
  );
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

export interface AssistantFigure {
  label: string;
  value: number;
  unit: string;
}

export interface AssistantEvidence {
  skill: string;
  store: string;
  query: string;
  params: Record<string, unknown>;
  rows: number;
  durationMs: number;
  error: string | null;
}

export interface AssistantClarification {
  question: string;
  options: Array<{ label: string; value: string }>;
}

// REQ-AI-007 (ADR-028) — a conversational answer: prose, figures, evidence per retrieval step, follow-ups and, when
// the assistant has to ask back, a clarification with choices. `cypher`/`rows` carry a graph step when one ran.
export interface AssistantAnswer {
  text: string;
  cypher: string;
  rows: Array<Record<string, unknown>>;
  cis: CiSummary[];
  intent: string;
  confidence: number;
  grounded: boolean;
  figures: AssistantFigure[];
  evidence: AssistantEvidence[];
  followUps: string[];
  clarification: AssistantClarification | null;
  /** REQ-AI-008: the conversation the answer was appended to and its turn. */
  conversationId: string;
  turnId: string;
}

/** REQ-AI-008 — a persisted conversation as listed, and a turn as it was answered. */
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

export interface AssistantTurn {
  id: string;
  at: string;
  question: string;
  locale: string;
  answer: AssistantAnswer;
}

export const ASSISTANT_ANSWER_FIELDS =
  'text cypher rows intent confidence grounded conversationId turnId figures { label value unit } evidence { skill store query params rows durationMs error } followUps clarification { question options { label value } } cis { ' +
  CI_SUMMARY_FIELDS +
  ' }';

const ANALYTICS_EMBED_QUERY =
  'query AnalyticsEmbed { analyticsEmbed { supersetUrl dashboardId token expiresInSeconds } }';
const ASK_ASSISTANT_MUTATION =
  'mutation AskAssistant($question: String!, $locale: String, $conversationId: UUID) { askAssistant(question: $question, locale: $locale, conversationId: $conversationId) { ' +
  ASSISTANT_ANSWER_FIELDS +
  ' } }';
const CONVERSATIONS_QUERY = 'query Conversations { conversations { id title createdAt updatedAt turnCount } }';
const CONVERSATION_QUERY =
  'query Conversation($id: UUID!) { conversation(id: $id) { id title createdAt updatedAt turnCount turns { id at question locale answer { ' +
  ASSISTANT_ANSWER_FIELDS +
  ' } } } }';
const DELETE_CONVERSATION_MUTATION = 'mutation DeleteConversation($id: UUID!) { deleteConversation(id: $id) }';

export const conversationsQueryKey = ['conversations'] as const;

export function conversationsQuery() {
  return queryOptions({
    queryKey: conversationsQueryKey,
    queryFn: ({ signal }) =>
      gql<{ conversations: Conversation[] }>(CONVERSATIONS_QUERY, {}, signal).then((d) => d.conversations),
  });
}

export type ConversationThread = Conversation & { turns: AssistantTurn[] };

/** One conversation with its turns; null when it no longer exists (or never belonged to this user). */
export function conversationQuery(id: string | null) {
  return queryOptions({
    queryKey: ['conversation', id] as const,
    queryFn: ({ signal }) =>
      gql<{ conversation: ConversationThread | null }>(CONVERSATION_QUERY, { id }, signal).then(
        (d) => d.conversation,
      ),
    enabled: id !== null,
  });
}

export function deleteConversation(id: string): Promise<boolean> {
  return gql<{ deleteConversation: boolean }>(DELETE_CONVERSATION_MUTATION, { id }).then(
    (d) => d.deleteConversation,
  );
}

/** One embed handshake per mount; the SDK asks again through fetchAnalyticsEmbed before the token expires. */
export function analyticsEmbedQuery() {
  return queryOptions({
    queryKey: ['analyticsEmbed'] as const,
    queryFn: ({ signal }) =>
      gql<{ analyticsEmbed: AnalyticsEmbed }>(ANALYTICS_EMBED_QUERY, {}, signal).then(
        (d) => d.analyticsEmbed,
      ),
    staleTime: 0,
    gcTime: 0,
  });
}

export function fetchAnalyticsEmbed(): Promise<AnalyticsEmbed> {
  return gql<{ analyticsEmbed: AnalyticsEmbed }>(ANALYTICS_EMBED_QUERY, {}).then((d) => d.analyticsEmbed);
}

export function askAssistant(
  question: string,
  locale: Locale,
  conversationId: string | null = null,
): Promise<AssistantAnswer> {
  return gql<{ askAssistant: AssistantAnswer }>(ASK_ASSISTANT_MUTATION, {
    question,
    locale,
    conversationId,
  }).then((d) => d.askAssistant);
}
