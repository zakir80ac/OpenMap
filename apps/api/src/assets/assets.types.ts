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
  warranty: WarrantyView | null;
  warrantyEndsAt: string | null;
  support: SupportView | null;
  supportContractId: string | null;
  /** From the row's own support entry, else resolved from the support contract by the field resolver. */
  supportEndsAt: string | null;
  endOfLife: EndOfLifeView | null;
  endOfSupport: string | null;
  dataGaps: AssetDataGap[];
  planId: string | null;
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
  supportExpired: number;
  endOfSupportPassed: number;
}

export interface BomLineView {
  description: string;
  manufacturer: string | null;
  model: string | null;
  sku: string | null;
  layer: CiLayer;
  quantity: number;
  received: number;
  unitCost: Money | null;
}

export interface InfraPlanView {
  id: string;
  number: string;
  name: string;
  kind: string;
  status: PlanStatus;
  bom: BomLineView[];
  estimatedCost: Money | null;
  targetSiteCiId: string | null;
  targetRackCiIds: string[];
  plannedLiveAt: string | null;
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
