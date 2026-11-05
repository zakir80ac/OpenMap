// REQ-CORE-001 REQ-CMDB-039 — asset management contract: lifecycle, purchasing, warranty, support, end of life,
// support contracts and vendor contacts. An asset record attaches to an owned CI by ciId (ADR-023): the register
// holds every CI of an owned type, the planned assets of a plan's BOM, and assets entered by hand.
import { z } from 'zod';
import { CI_TYPES, ciLayerSchema, ciTypeSchema, type CiType } from './ci.js';

/** Asset lifecycle stages. An asset is in exactly one; every move is audited. `planned` assets come from an infrastructure plan's BOM. */
export const ASSET_STAGES = ['planned', 'in_stock', 'deployed', 'spare', 'rma', 'retired', 'disposed'] as const;
export const assetStageSchema = z.enum(ASSET_STAGES);
export type AssetStage = z.infer<typeof assetStageSchema>;

/**
 * Where an asset record came from (ADR-023): `plan` rows are a plan's BOM, `discovery` rows are created by the
 * reconciler for every CI of an owned type, `manual` rows are entered by hand for items with no network presence.
 */
export const ASSET_SOURCES = ['plan', 'discovery', 'manual'] as const;
export const assetSourceSchema = z.enum(ASSET_SOURCES);
export type AssetSource = z.infer<typeof assetSourceSchema>;

/**
 * CI types the organisation owns, licenses or subscribes to and therefore tracks as assets with warranty, support
 * and end-of-life dates. Everything else in the CMDB (addresses, interfaces, records, rules, workloads, sites,
 * accounts, vendors) is topology or context, not property. Order follows CI_TYPES.
 */
export const OWNED_CI_TYPES = [
  'host',
  'chassis',
  'blade',
  'bmc',
  'hypervisor',
  'vm_cluster',
  'vm',
  'operating_system',
  'k8s_cluster',
  'network_device',
  'load_balancer',
  'storage_array',
  'fc_switch',
  'database',
  'database_cluster',
  'certificate',
  'application',
  'software',
  'software_instance',
  'licence',
  'rack',
  'pdu',
  'ups',
  'cooling_unit',
  'patch_panel',
  'cloud_account',
  'cloud_resource',
  'saas_application',
  'saas_tenant',
] as const satisfies readonly CiType[];
export type OwnedCiType = (typeof OWNED_CI_TYPES)[number];
const OWNED = new Set<string>(OWNED_CI_TYPES);
export function isOwnedCiType(type: string): type is OwnedCiType {
  return OWNED.has(type) && (CI_TYPES as readonly string[]).includes(type);
}

/** The dates every asset must carry; a null one is a data gap the register flags for manual entry. */
export const ASSET_DATA_GAPS = ['warranty', 'support', 'end_of_life'] as const;
export const assetDataGapSchema = z.enum(ASSET_DATA_GAPS);
export type AssetDataGap = z.infer<typeof assetDataGapSchema>;

/** ISO 4217 currency code. */
const currency = z.string().length(3);
const money = z.object({ amount: z.number().min(0), currency });

export const vendorContactSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  vendorCiId: z.uuid(),
  name: z.string().min(1),
  role: z.string().min(1),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  portalUrl: z.string().nullable(),
  /** Hours and time zone in which this contact may be reached, free text. */
  availability: z.string().nullable(),
  escalationLevel: z.number().int().min(1),
});
export type VendorContact = z.infer<typeof vendorContactSchema>;

export const SUPPORT_LEVELS = ['none', 'basic', 'next_business_day', 'four_hour', 'mission_critical', 'custom'] as const;

export const supportContractSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  vendorCiId: z.uuid(),
  contractNumber: z.string().min(1),
  title: z.string().min(1),
  level: z.enum(SUPPORT_LEVELS),
  /** Response time commitment in minutes for the highest severity. */
  responseMinutes: z.number().int().positive().nullable(),
  startsAt: z.iso.date(),
  endsAt: z.iso.date(),
  autoRenews: z.boolean(),
  annualCost: money.nullable(),
  costCentreCiId: z.uuid().nullable(),
  primaryContactId: z.uuid().nullable(),
  /** External identifiers in vendor systems (Dell TechDirect, Cisco SNTC, HPE). */
  externalIds: z.array(z.object({ source: z.string().min(1), id: z.string().min(1) })),
  documentRefs: z.array(z.string()),
});
export type SupportContract = z.infer<typeof supportContractSchema>;

export const DATE_SOURCES = ['vendor_api', 'purchase_record', 'manual'] as const;
export const dateSourceSchema = z.enum(DATE_SOURCES);
export type DateSource = z.infer<typeof dateSourceSchema>;

export const warrantySchema = z.object({
  provider: z.string().min(1),
  /** Service level as the vendor names it; null when the collector saw only the end date. */
  level: z.string().min(1).nullable(),
  /** Null when only the end date is known (a vendor API or a label reports the expiry alone). */
  startsAt: z.iso.date().nullable(),
  endsAt: z.iso.date(),
  /** Where the dates came from: vendor API, invoice, manual. */
  source: dateSourceSchema,
  verifiedAt: z.iso.datetime().nullable(),
});
export type Warranty = z.infer<typeof warrantySchema>;

/** Vendor support cover entered on the asset itself; a SupportContract row (supportContractId) is the other way. */
export const supportSchema = z.object({
  provider: z.string().min(1),
  contractNumber: z.string().min(1).nullable(),
  level: z.string().min(1).nullable(),
  endsAt: z.iso.date(),
  source: dateSourceSchema,
  verifiedAt: z.iso.datetime().nullable(),
});
export type Support = z.infer<typeof supportSchema>;

export const endOfLifeSchema = z.object({
  endOfSale: z.iso.date().nullable(),
  endOfSoftwareMaintenance: z.iso.date().nullable(),
  endOfSupport: z.iso.date().nullable(),
  source: z.string().min(1),
  verifiedAt: z.iso.datetime().nullable(),
});
export type EndOfLife = z.infer<typeof endOfLifeSchema>;

/** The data gaps of an asset: each of the three dates that is missing. */
export function assetDataGaps(asset: { warranty: unknown; support: unknown; supportContractId: string | null; endOfLife: { endOfSupport: string | null } | null }): AssetDataGap[] {
  const gaps: AssetDataGap[] = [];
  if (asset.warranty === null || asset.warranty === undefined) gaps.push('warranty');
  if ((asset.support === null || asset.support === undefined) && asset.supportContractId === null) gaps.push('support');
  if (asset.endOfLife === null || asset.endOfLife.endOfSupport === null) gaps.push('end_of_life');
  return gaps;
}

export const PLAN_KINDS = ['new_infrastructure', 'stack_expansion', 'refresh', 'migration', 'decommission'] as const;
export const PLAN_STATUSES = ['draft', 'approved', 'building', 'live', 'cancelled'] as const;

/** One line of a plan's bill of materials. Each line becomes `quantity` assets in stage `planned`. */
export const bomLineSchema = z.object({
  description: z.string().min(1),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  sku: z.string().nullable(),
  /** Layer the resulting CIs will live in (CI_LAYERS from ci.ts). */
  layer: z.string().min(1),
  quantity: z.number().int().positive(),
  received: z.number().int().min(0),
  unitCost: money.nullable(),
  vendorCiId: z.uuid().nullable(),
});

/**
 * Infrastructure plan: "plan for new infra or stack and enter the details". Replaces purchase
 * orders; procurement happens in the finance system and is linked by reference only.
 */
export const infraPlanSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  number: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  kind: z.enum(PLAN_KINDS),
  status: z.enum(PLAN_STATUSES),
  owner: z.string().min(1),
  targetSiteCiId: z.uuid().nullable(),
  targetRackCiIds: z.array(z.uuid()),
  costCentreCiId: z.uuid().nullable(),
  bom: z.array(bomLineSchema).min(1),
  estimatedCost: money.nullable(),
  /** External procurement references (ERP order numbers, quotes), never managed here. */
  externalRefs: z.array(z.object({ source: z.string().min(1), id: z.string().min(1) })),
  plannedLiveAt: z.iso.date().nullable(),
  /** Asset records created from this plan's BOM. */
  assetIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type InfraPlan = z.infer<typeof infraPlanSchema>;

export const DEPRECIATION_METHODS = ['straight_line', 'declining_balance', 'none'] as const;

export const assetRecordSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  /** The CI this asset record describes; null while planned and not yet discovered. */
  ciId: z.uuid().nullable(),
  /** The CI's type at creation, kept so a register row can be grouped without the CI. */
  ciType: ciTypeSchema.nullable(),
  /** Layer of the register the asset lists under: the CI's layer, the BOM line's layer, or the manual choice. */
  layer: ciLayerSchema,
  source: assetSourceSchema,
  assetTag: z.string().min(1),
  serialNumber: z.string().nullable(),
  /** Null when neither discovery nor a person has recorded it: a software instance or a cloud resource has none. */
  manufacturer: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  partNumber: z.string().nullable(),
  stage: assetStageSchema,
  stageChangedAt: z.iso.datetime(),
  /** Physical location when not deployed in a rack: a room or storage CI. */
  locationCiId: z.uuid().nullable(),
  custodian: z.string().nullable(),
  ownerCostCentreCiId: z.uuid().nullable(),
  /** The plan whose BOM created this asset; null for assets discovered or imported directly. */
  planId: z.uuid().nullable(),
  purchasedAt: z.iso.date().nullable(),
  purchaseCost: money.nullable(),
  depreciation: z.object({
    method: z.enum(DEPRECIATION_METHODS),
    usefulLifeMonths: z.number().int().positive(),
    residualValue: money,
  }),
  warranty: warrantySchema.nullable(),
  support: supportSchema.nullable(),
  supportContractId: z.uuid().nullable(),
  endOfLife: endOfLifeSchema.nullable(),
  /** Spare-part stock control; null for non-stocked assets. */
  stock: z.object({ onHand: z.number().int().min(0), reorderPoint: z.number().int().min(0) }).nullable(),
  tags: z.array(z.string().min(1)),
  customFields: z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AssetRecord = z.infer<typeof assetRecordSchema>;

/** Append-only audit entry written on every stage change or field edit. */
export const assetAuditSchema = z.object({
  id: z.uuid(),
  assetId: z.uuid(),
  actor: z.string().min(1),
  at: z.iso.datetime(),
  field: z.string().min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
  note: z.string().nullable(),
});
export type AssetAudit = z.infer<typeof assetAuditSchema>;

/**
 * The register fields a CI's observed attributes already carry (ADR-023). The same mapping runs in Postgres for the
 * one-off backfill (migration 0015) and here for every CI the reconciler creates or updates, and when a person
 * labels an unknown CI into an owned type. Values are taken as the collectors report them; nothing is invented, so a
 * field the attributes lack stays null and shows as a data gap.
 */
export interface AssetFieldsFromCi {
  assetTag: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  partNumber: string | null;
  purchasedAt: string | null;
  warranty: Warranty | null;
  support: Support | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** Types whose `expiresAt` is a subscription or entitlement end, recorded as support cover. */
const SUBSCRIPTION_TYPES: ReadonlySet<string> = new Set(['licence', 'saas_application', 'saas_tenant', 'certificate']);

function text(attributes: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function isoDate(attributes: Record<string, unknown>, key: string): string | null {
  const value = text(attributes, key);
  return value !== null && ISO_DATE.test(value) ? value : null;
}

export function assetFieldsFromCi(type: string, attributes: Record<string, unknown>): AssetFieldsFromCi {
  const manufacturer = text(attributes, 'manufacturer', 'vendor');
  const warrantyEnd = isoDate(attributes, 'warrantyEnd');
  const warrantyProvider = text(attributes, 'warrantyProvider') ?? manufacturer;
  const expiresAt = isoDate(attributes, 'expiresAt');
  const vendor = text(attributes, 'vendor');
  return {
    assetTag: text(attributes, 'assetTag'),
    serialNumber: text(attributes, 'serialNumber'),
    manufacturer,
    model: text(attributes, 'model', 'product', 'software', 'name', 'sku', 'resourceType'),
    partNumber: text(attributes, 'partNumber', 'sku'),
    purchasedAt: isoDate(attributes, 'purchaseDate'),
    warranty:
      warrantyEnd !== null && warrantyProvider !== null
        ? { provider: warrantyProvider, level: text(attributes, 'warrantyLevel'), startsAt: isoDate(attributes, 'purchaseDate'), endsAt: warrantyEnd, source: 'vendor_api', verifiedAt: null }
        : null,
    support:
      SUBSCRIPTION_TYPES.has(type) && expiresAt !== null && vendor !== null
        ? { provider: vendor, contractNumber: text(attributes, 'poNumber'), level: text(attributes, 'licenceType'), endsAt: expiresAt, source: 'vendor_api', verifiedAt: null }
        : null,
  };
}
