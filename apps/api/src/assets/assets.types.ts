// REQ-CMDB-002 — view types for AssetRecord, InfraPlan, BomLine, SupportContract and VendorContact.
import type { CiLayer } from '@openmap/contracts';
import type { Money } from '../common/money.js';

export type AssetStage = 'planned' | 'in_stock' | 'deployed' | 'spare' | 'rma' | 'retired' | 'disposed';
export type PlanStatus = 'draft' | 'approved' | 'building' | 'live' | 'cancelled';

export interface AssetRecordView {
  id: string;
  ciId: string | null;
  assetTag: string;
  serialNumber: string | null;
  manufacturer: string;
  model: string;
  stage: AssetStage;
  warrantyEndsAt: string | null;
  supportContractId: string | null;
  endOfSupport: string | null;
  planId: string | null;
  purchaseCost: Money | null;
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
