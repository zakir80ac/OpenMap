// REQ-CMDB-002 REQ-CMDB-039 REQ-CMDB-040 — zod schemas for PlanInput, the register filter, the asset detail and
// manual-asset inputs and the asset/plan mutations. Dates a person enters are calendar dates (YYYY-MM-DD).
import { ASSETS } from '@openmap/constants';
import { z } from 'zod';
import {
  DEPRECIATION_METHODS,
  ASSET_DATA_GAPS,
  ASSET_SOURCES,
  ASSET_STAGES,
  PLAN_KINDS,
  PLAN_STATUSES,
  ciLayerSchema,
  ciTypeSchema,
} from '@openmap/contracts';
import { CURRENCY_CODE_LENGTH } from '../common/money.js';

export const bomLineInputSchema = z.object({
  description: z.string().min(1),
  manufacturer: z.string().min(1).nullish(),
  model: z.string().min(1).nullish(),
  sku: z.string().min(1).nullish(),
  layer: ciLayerSchema,
  quantity: z.number().int().positive(),
  unitCostAmount: z.number().min(0).nullish(),
  unitCostCurrency: z.string().length(CURRENCY_CODE_LENGTH).nullish(),
});

export const planInputSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  kind: z.enum(PLAN_KINDS),
  targetSiteId: z.uuid().nullish(),
  targetRackIds: z.array(z.uuid()).nullish(),
  bom: z.array(bomLineInputSchema).min(1),
  plannedLiveAt: z.iso.datetime({ offset: true }).nullish(),
});
export type PlanInput = z.infer<typeof planInputSchema>;
export type BomLineInput = z.infer<typeof bomLineInputSchema>;

export const assetFilterSchema = z.object({
  layers: z.array(ciLayerSchema).nullish(),
  types: z.array(ciTypeSchema).nullish(),
  stages: z.array(z.enum(ASSET_STAGES)).nullish(),
  sources: z.array(z.enum(ASSET_SOURCES)).nullish(),
  dataGaps: z.array(z.enum(ASSET_DATA_GAPS)).nullish(),
  text: z.string().nullish(),
  warrantyExpiringWithinDays: z.number().int().min(0).nullish(),
  belowReorderPoint: z.boolean().nullish(),
});
export type AssetFilterInput = z.infer<typeof assetFilterSchema>;

export const assetsArgsSchema = z.object({
  filter: assetFilterSchema.nullish(),
  stage: z.array(z.enum(ASSET_STAGES)).nullish(),
  warrantyExpiringWithinDays: z.number().int().min(0).nullish(),
  first: z.number().int().nullish(),
  after: z.string().min(1).nullish(),
});

const trimmed = z.string().trim().min(1);
const calendarDate = z.iso.date();

export const warrantyInputSchema = z.object({
  provider: trimmed,
  level: trimmed.nullish(),
  startsAt: calendarDate.nullish(),
  endsAt: calendarDate,
});
/** REQ-CMDB-042 — a subscription needs an end date or a credit balance; credits need their unit. */
export const subscriptionInputSchema = z
  .object({
    provider: trimmed,
    plan: trimmed.nullish(),
    startsAt: calendarDate.nullish(),
    endsAt: calendarDate.nullish(),
    creditsRemaining: z.number().min(0).nullish(),
    creditsUnit: trimmed.nullish(),
    creditsCurrency: z.string().length(CURRENCY_CODE_LENGTH).nullish(),
  })
  .refine((v) => v.endsAt || (v.creditsRemaining !== null && v.creditsRemaining !== undefined), {
    message: 'a subscription needs an end date or a credit balance',
  })
  .refine((v) => v.creditsRemaining === null || v.creditsRemaining === undefined || v.creditsUnit, {
    message: 'credits need a unit',
  });
export const supportInputSchema = z.object({
  provider: trimmed,
  contractNumber: trimmed.nullish(),
  level: trimmed.nullish(),
  endsAt: calendarDate,
});
export const endOfLifeInputSchema = z
  .object({
    endOfSale: calendarDate.nullish(),
    endOfSoftwareMaintenance: calendarDate.nullish(),
    endOfSupport: calendarDate.nullish(),
  })
  .refine((v) => v.endOfSale || v.endOfSoftwareMaintenance || v.endOfSupport, {
    message: 'at least one end-of-life date is required',
  });

/** Every field is optional: an omitted (undefined) field is left alone, an explicit null clears it. */
export const assetDetailsInputSchema = z.object({
  manufacturer: trimmed.nullish(),
  model: trimmed.nullish(),
  serialNumber: trimmed.nullish(),
  partNumber: trimmed.nullish(),
  custodian: trimmed.nullish(),
  purchasedAt: calendarDate.nullish(),
  purchaseCostAmount: z.number().min(0).nullish(),
  purchaseCostCurrency: z.string().length(CURRENCY_CODE_LENGTH).nullish(),
  warranty: warrantyInputSchema.nullish(),
  subscription: subscriptionInputSchema.nullish(),
  support: supportInputSchema.nullish(),
  endOfLife: endOfLifeInputSchema.nullish(),
  /** REQ-CMDB-017 */
  depreciation: z
    .object({ method: z.enum(DEPRECIATION_METHODS), usefulLifeMonths: z.number().int().min(1).max(ASSETS.maxUsefulLifeMonths), residualValueAmount: z.number().min(0) })
    .nullish(),
  /** REQ-CMDB-019; null stops stock control for the asset. */
  stock: z.object({ onHand: z.number().int().min(0), reorderPoint: z.number().int().min(0) }).nullish(),
  note: z.string().nullish(),
});
export type AssetDetailsInput = z.infer<typeof assetDetailsInputSchema>;

export const manualAssetInputSchema = z.object({
  layer: ciLayerSchema,
  type: ciTypeSchema,
  name: trimmed,
  assetTag: trimmed.nullish(),
  locationCiId: z.uuid().nullish(),
  details: assetDetailsInputSchema,
});
export type ManualAssetInput = z.infer<typeof manualAssetInputSchema>;

export const updateAssetArgsSchema = z.object({ assetId: z.uuid(), input: assetDetailsInputSchema });
export const plansArgsSchema = z.object({ status: z.array(z.enum(PLAN_STATUSES)).nullish() });
export const setPlanStatusSchema = z.object({ planId: z.uuid(), status: z.enum(PLAN_STATUSES) });
/** REQ-CMDB-020 (ADR-034) — a delivery against one BOM line; serials and tags must not repeat within it. */
export const receiptInputSchema = z
  .object({
    planId: z.uuid(),
    position: z.number().int().min(0),
    receivedOn: calendarDate,
    reference: z.string().trim().min(1).max(ASSETS.receiptReferenceMaxLength).nullish(),
    locationId: z.uuid().nullish(),
    units: z.array(z.object({ serialNumber: trimmed, assetTag: trimmed.nullish() })).min(1),
  })
  .superRefine((input, ctx) => {
    const serials = input.units.map((u) => u.serialNumber);
    const tags = input.units.map((u) => u.assetTag).filter((t): t is string => typeof t === 'string');
    if (new Set(serials).size !== serials.length)
      ctx.addIssue({ code: 'custom', path: ['units'], message: 'a serial number appears more than once' });
    if (new Set(tags).size !== tags.length)
      ctx.addIssue({ code: 'custom', path: ['units'], message: 'an asset tag appears more than once' });
  });
export type ReceiptInput = z.infer<typeof receiptInputSchema>;

export const setAssetStageSchema = z.object({
  assetId: z.uuid(),
  stage: z.enum(ASSET_STAGES),
  note: z.string().nullish(),
});

/** REQ-CMDB-041 — register page arguments: 1-based page, page size capped at ASSETS.registerMaxPageSize. */
export const assetPageArgsSchema = z.object({
  filter: assetFilterSchema.nullish(),
  page: z.number().int().min(1).nullish(),
  pageSize: z.number().int().min(1).max(ASSETS.registerMaxPageSize).nullish(),
});
