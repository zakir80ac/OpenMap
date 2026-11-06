// REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 (ADR-035) — read models of the commercial register: contracts,
// vendors with their contacts, and cost centres, each over its CI.
import type { ContractDocument, ContractKind, CostCentreKind } from '@openmap/contracts';
import type { CiRecord } from '../ci/ci.types.js';
import type { Money } from '../common/money.js';

export interface ContractView {
  ci: CiRecord;
  kind: ContractKind;
  contractNumber: string;
  title: string;
  level: string | null;
  responseMinutes: number | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Whole days to the end (negative once ended); null without an end date. */
  daysToEnd: number | null;
  noticeDays: number | null;
  /** Last day to give notice (end less the notice period). */
  noticeBy: string | null;
  autoRenews: boolean;
  expired: boolean;
  annualCost: Money | null;
  coveredAssets: number;
  vendorCiId: string | null;
  costCentreCiId: string | null;
  documents: ContractDocument[];
}

export interface VendorContactView {
  id: string;
  vendorCiId: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  portalUrl: string | null;
  availability: string | null;
  escalationLevel: number;
}

export interface VendorView {
  ci: CiRecord;
  category: string | null;
  supportPortal: string | null;
  accountManager: string | null;
  contracts: number;
  activeContracts: number;
  coveredAssets: number;
  /** Annual cost of its active contracts when they share one currency; null otherwise. */
  annualCost: Money | null;
  contacts: number;
}

export interface VendorDetailView {
  vendor: VendorView;
  contacts: VendorContactView[];
  contracts: ContractView[];
}

export interface CostCentreView {
  ci: CiRecord;
  code: string;
  kind: CostCentreKind;
  owner: string | null;
  annualBudget: Money | null;
  contracts: number;
  annualContractCost: Money | null;
  assets: number;
  plans: number;
}

export interface ContractFilter {
  kinds: readonly ContractKind[];
  vendorId: string | null;
  costCentreId: string | null;
  text: string | null;
  expiringWithinDays: number | null;
  expired: boolean | null;
}
