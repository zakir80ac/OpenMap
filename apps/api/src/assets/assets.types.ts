// REQ-CMDB-002 REQ-CMDB-039 — view types for AssetRecord, InfraPlan, BomLine, SupportContract and VendorContact,
// plus the register summary per layer (ADR-023).
import type { AssetDataGap, AssetSource, CiLayer, CiType } from '@openmap/contracts';
import type { Money } from '../common/money.js';

export type AssetStage = 'planned' | 'in_stock' | 'deployed' | 'spare' | 'rma' | 'retired' | 'disposed';
export type PlanStatus = 'draft' | 'approved' | 'building' | 'live' | 'cancelled';

/** Cover as GraphQL serves it: calendar dates become ISO instants (UTC midnight) for the DateTime scalar. */
export interface WarrantyView {
  provider: string;
  level: string | null;
  startsAt: string | null;
  endsAt: string;
  source: string;
  verifiedAt: string | null;
}
export interface CreditsView {
  remaining: number;
  unit: string;
  currency: string | null;
  asOf: string;
}
export interface SubscriptionView {
  provider: string;
  plan: string | null;
  startsAt: string | null;
  endsAt: string | null;
  credits: CreditsView | null;
  source: string;
  verifiedAt: string | null;
}
export interface SupportView {
  provider: string;
  contractNumber: string | null;
  level: string | null;
  endsAt: string;
  source: string;
  verifiedAt: string | null;
}
export interface EndOfLifeView {
  endOfSale: string | null;
  endOfSoftwareMaintenance: string | null;
  endOfSupport: string | null;
  source: string;
  verifiedAt: string | null;
}

export interface AssetRecordView {
  id: string;
  ciId: string | null;
  ciType: CiType | null;
  layer: CiLayer;
  source: AssetSource;
  assetTag: string;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  partNumber: string | null;
  stage: AssetStage;
  stageChangedAt: string;
  custodian: string | null;
  locationCiId: string | null;
  purchasedAt: string | null;
  purchaseCost: Money | null;
  /** REQ-CMDB-017: the schedule and today's value under it. */
  depreciation: { method: string; usefulLifeMonths: number; residualValue: Money };
  bookValue: Money | null;
  /** REQ-CMDB-019: stock control of a stocked spare. */
  stock: { onHand: number; reorderPoint: number; belowReorderPoint: boolean } | null;
  warranty: WarrantyView | null;
  warrantyEndsAt: string | null;
  subscription: SubscriptionView | null;
  subscriptionEndsAt: string | null;
  creditsRemaining: number | null;
  support: SupportView | null;
  supportContractId: string | null;
  /** From the row's own support entry, else resolved from the support contract by the field resolver. */
  supportEndsAt: string | null;
  endOfLife: EndOfLifeView | null;
  endOfSupport: string | null;
  dataGaps: AssetDataGap[];
  planId: string | null;
  /** ADR-034: the plan's BOM line this unit belongs to. */
  bomLineId: string | null;
}

export interface AssetAuditView {
  id: string;
  actor: string;
  at: string;
  field: string;
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
}

export interface AssetSummaryView {
  layer: CiLayer;
  count: number;
  needsData: number;
  warrantyExpired: number;
  subscriptionExpired: number;
  supportExpired: number;
  endOfSupportPassed: number;
  belowReorderPoint: number;
}

export interface BomLineView {
  id: string;
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

export interface InfraPlanView {
  id: string;
  number: string;
  name: string;
  description: string;
  kind: string;
  status: PlanStatus;
  owner: string;
  bom: BomLineView[];
  estimatedCost: Money | null;
  targetSiteCiId: string | null;
  targetRackCiIds: string[];
  plannedLiveAt: string | null;
}

/** REQ-CMDB-020 (ADR-034): one delivery against a BOM line. */
export interface PlanReceiptView {
  id: string;
  planId: string;
  bomLineId: string;
  position: number;
  description: string;
  quantity: number;
  /** Calendar day as an ISO instant (midnight UTC), the DateTime scalar's form. */
  receivedOn: string;
  receivedBy: string;
  reference: string | null;
  locationCiId: string | null;
  assetIds: string[];
  createdAt: string;
}

export interface SupportContractView {
  id: string;
  vendorCiId: string;
  contractNumber: string;
  level: string;
  endsAt: string;
  primaryContactId: string | null;
}

export interface VendorContactView {
  id: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  portalUrl: string | null;
}

/** REQ-CMDB-041 — one page of the register with its totals. */
export interface AssetPageView {
  items: AssetRecordView[];
  totalCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
}
