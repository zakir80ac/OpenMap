// REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 (ADR-035) — GraphQL operations behind the Commercial screen:
// contracts, vendors with contacts, cost centres, and the asset's covering contract and owning cost centre.
import { queryOptions } from '@tanstack/react-query';
import type { ContractKind, CostCentreKind } from '@openmap/contracts';
import { gql } from './graphql';
import { CI_SUMMARY_FIELDS, type CiSummary } from './queries';
import type { Money } from './estate-queries';

export interface ContractDocument {
  title: string;
  location: string;
}

export interface Contract {
  ci: CiSummary;
  kind: ContractKind;
  contractNumber: string;
  title: string;
  level: string | null;
  responseMinutes: number | null;
  startsAt: string | null;
  endsAt: string | null;
  daysToEnd: number | null;
  noticeDays: number | null;
  noticeBy: string | null;
  autoRenews: boolean;
  expired: boolean;
  annualCost: Money | null;
  coveredAssets: number;
  vendor: { id: string; displayName: string } | null;
  costCentre: { id: string; displayName: string } | null;
  documents: ContractDocument[];
}

export interface Vendor {
  ci: CiSummary;
  category: string | null;
  supportPortal: string | null;
  accountManager: string | null;
  contracts: number;
  activeContracts: number;
  coveredAssets: number;
  annualCost: Money | null;
  contacts: number;
}

export interface VendorContact {
  id: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  portalUrl: string | null;
  availability: string | null;
  escalationLevel: number;
}

export interface VendorDetail {
  vendor: Vendor;
  contacts: VendorContact[];
  contracts: Contract[];
}

export interface CostCentre {
  ci: CiSummary;
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
  kinds?: ContractKind[];
  vendorId?: string;
  costCentreId?: string;
  text?: string;
  expiringWithinDays?: number;
  expired?: boolean;
}

export interface ContractInput {
  vendorId: string;
  costCentreId: string | null;
  contractNumber: string;
  kind: ContractKind;
  title: string;
  level: string | null;
  responseMinutes: number | null;
  startsAt: string;
  endsAt: string;
  autoRenews: boolean;
  noticeDays: number | null;
  annualCost: number | null;
  currency: string | null;
  documents: ContractDocument[];
}

export interface VendorInput {
  name: string;
  category: string | null;
  supportPortal: string | null;
  accountManager: string | null;
}

export interface CostCentreInput {
  code: string;
  name: string;
  kind: CostCentreKind;
  owner: string | null;
  annualBudget: number | null;
  currency: string | null;
}

export interface VendorContactInput {
  id?: string;
  vendorId: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  portalUrl: string | null;
  availability: string | null;
  escalationLevel: number;
}

const MONEY = '{ amount currency }';
const CONTRACT_FIELDS =
  'ci { ' +
  CI_SUMMARY_FIELDS +
  ' } kind contractNumber title level responseMinutes startsAt endsAt daysToEnd noticeDays noticeBy autoRenews expired annualCost ' +
  MONEY +
  ' coveredAssets vendor { id displayName } costCentre { id displayName } documents { title location }';
const VENDOR_FIELDS =
  'ci { ' + CI_SUMMARY_FIELDS + ' } category supportPortal accountManager contracts activeContracts coveredAssets annualCost ' + MONEY + ' contacts';
const CONTACT_FIELDS = 'id name role email phone portalUrl availability escalationLevel';
const COST_CENTRE_FIELDS =
  'ci { ' + CI_SUMMARY_FIELDS + ' } code kind owner annualBudget ' + MONEY + ' contracts annualContractCost ' + MONEY + ' assets plans';

const CONTRACTS_QUERY = 'query Contracts($filter: ContractFilter) { contracts(filter: $filter) { ' + CONTRACT_FIELDS + ' } }';
const VENDORS_QUERY = 'query Vendors($text: String) { vendors(text: $text) { ' + VENDOR_FIELDS + ' } }';
const VENDOR_QUERY =
  'query Vendor($id: UUID!) { vendor(id: $id) { vendor { ' + VENDOR_FIELDS + ' } contacts { ' + CONTACT_FIELDS + ' } contracts { ' + CONTRACT_FIELDS + ' } } }';
const COST_CENTRES_QUERY = 'query CostCentres { costCentres { ' + COST_CENTRE_FIELDS + ' } }';
const UPSERT_CONTRACT =
  'mutation UpsertContract($id: UUID, $input: ContractInput!) { upsertContract(id: $id, input: $input) { ' + CONTRACT_FIELDS + ' } }';
const UPSERT_VENDOR = 'mutation UpsertVendor($id: UUID, $input: VendorInput!) { upsertVendor(id: $id, input: $input) { ' + VENDOR_FIELDS + ' } }';
const UPSERT_COST_CENTRE =
  'mutation UpsertCostCentre($id: UUID, $input: CostCentreInput!) { upsertCostCentre(id: $id, input: $input) { ' + COST_CENTRE_FIELDS + ' } }';
const UPSERT_CONTACT = 'mutation UpsertVendorContact($input: VendorContactInput!) { upsertVendorContact(input: $input) { ' + CONTACT_FIELDS + ' } }';
const DELETE_CONTACT = 'mutation DeleteVendorContact($id: UUID!) { deleteVendorContact(id: $id) }';
const SET_ASSET_CONTRACT =
  'mutation SetAssetContract($assetId: UUID!, $contractId: UUID) { setAssetContract(assetId: $assetId, contractId: $contractId) { id } }';

export function contractsQuery(filter: ContractFilter) {
  return queryOptions({
    queryKey: ['contracts', filter] as const,
    queryFn: ({ signal }) => gql<{ contracts: Contract[] }>(CONTRACTS_QUERY, { filter }, signal).then((d) => d.contracts),
  });
}

export function vendorsQuery(text: string | null) {
  return queryOptions({
    queryKey: ['vendors', text] as const,
    queryFn: ({ signal }) => gql<{ vendors: Vendor[] }>(VENDORS_QUERY, { text }, signal).then((d) => d.vendors),
  });
}

export function vendorQuery(id: string) {
  return queryOptions({
    queryKey: ['vendor', id] as const,
    queryFn: ({ signal }) => gql<{ vendor: VendorDetail | null }>(VENDOR_QUERY, { id }, signal).then((d) => d.vendor),
  });
}

export function costCentresQuery() {
  return queryOptions({
    queryKey: ['costCentres'] as const,
    queryFn: ({ signal }) => gql<{ costCentres: CostCentre[] }>(COST_CENTRES_QUERY, {}, signal).then((d) => d.costCentres),
  });
}

export function upsertContract(id: string | null, input: ContractInput): Promise<Contract> {
  return gql<{ upsertContract: Contract }>(UPSERT_CONTRACT, { id, input }).then((d) => d.upsertContract);
}

export function upsertVendor(id: string | null, input: VendorInput): Promise<Vendor> {
  return gql<{ upsertVendor: Vendor }>(UPSERT_VENDOR, { id, input }).then((d) => d.upsertVendor);
}

export function upsertCostCentre(id: string | null, input: CostCentreInput): Promise<CostCentre> {
  return gql<{ upsertCostCentre: CostCentre }>(UPSERT_COST_CENTRE, { id, input }).then((d) => d.upsertCostCentre);
}

export function upsertVendorContact(input: VendorContactInput): Promise<VendorContact> {
  return gql<{ upsertVendorContact: VendorContact }>(UPSERT_CONTACT, { input }).then((d) => d.upsertVendorContact);
}

export function deleteVendorContact(id: string): Promise<boolean> {
  return gql<{ deleteVendorContact: boolean }>(DELETE_CONTACT, { id }).then((d) => d.deleteVendorContact);
}

/** ADR-035 — the contract covering an asset; null removes the cover. */
export function setAssetContract(assetId: string, contractId: string | null): Promise<{ id: string }> {
  return gql<{ setAssetContract: { id: string } }>(SET_ASSET_CONTRACT, { assetId, contractId }).then((d) => d.setAssetContract);
}
