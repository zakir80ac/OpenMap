// REQ-CORE-001 — asset management contract: lifecycle, purchasing, warranty, support contracts
// and vendor contacts. An asset record attaches to a physical or licensed CI by ciId.
import { z } from 'zod';

/** Asset lifecycle stages. An asset is in exactly one; every move is audited. `planned` assets come from an infrastructure plan's BOM. */
export const ASSET_STAGES = ['planned', 'in_stock', 'deployed', 'spare', 'rma', 'retired', 'disposed'] as const;
export const assetStageSchema = z.enum(ASSET_STAGES);
export type AssetStage = z.infer<typeof assetStageSchema>;

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

export const warrantySchema = z.object({
  provider: z.string().min(1),
  level: z.string().min(1),
  startsAt: z.iso.date(),
  endsAt: z.iso.date(),
  /** Where the dates came from: vendor API, invoice, manual. */
  source: z.enum(['vendor_api', 'purchase_record', 'manual']),
  verifiedAt: z.iso.datetime().nullable(),
});
export type Warranty = z.infer<typeof warrantySchema>;

export const endOfLifeSchema = z.object({
  endOfSale: z.iso.date().nullable(),
  endOfSoftwareMaintenance: z.iso.date().nullable(),
  endOfSupport: z.iso.date().nullable(),
  source: z.string().min(1),
  verifiedAt: z.iso.datetime().nullable(),
});

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
  assetTag: z.string().min(1),
  serialNumber: z.string().nullable(),
  manufacturer: z.string().min(1),
  model: z.string().min(1),
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
