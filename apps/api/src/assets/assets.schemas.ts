// REQ-CMDB-002 REQ-CMDB-039 REQ-CMDB-040 — zod schemas for PlanInput, the register filter, the asset detail and
// manual-asset inputs and the asset/plan mutations. Dates a person enters are calendar dates (YYYY-MM-DD).
import { z } from 'zod';
import { ASSET_DATA_GAPS, ASSET_SOURCES, ASSET_STAGES, PLAN_KINDS, PLAN_STATUSES, ciLayerSchema, ciTypeSchema } from '@openmap/contracts';
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
  .refine((v) => v.endOfSale || v.endOfSoftwareMaintenance || v.endOfSupport, { message: 'at least one end-of-life date is required' });

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
  support: supportInputSchema.nullish(),
  endOfLife: endOfLifeInputSchema.nullish(),
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
export const setAssetStageSchema = z.object({ assetId: z.uuid(), stage: z.enum(ASSET_STAGES), note: z.string().nullish() });
