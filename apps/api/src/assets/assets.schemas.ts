// REQ-CMDB-002 — zod schemas for PlanInput and the asset/plan mutations.
import { z } from 'zod';
import { ASSET_STAGES, PLAN_KINDS, PLAN_STATUSES, ciLayerSchema } from '@openmap/contracts';
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

export const assetsArgsSchema = z.object({
  stage: z.array(z.enum(ASSET_STAGES)).nullish(),
  warrantyExpiringWithinDays: z.number().int().min(0).nullish(),
  first: z.number().int().nullish(),
  after: z.string().min(1).nullish(),
});

export const plansArgsSchema = z.object({ status: z.array(z.enum(PLAN_STATUSES)).nullish() });
export const setPlanStatusSchema = z.object({ planId: z.uuid(), status: z.enum(PLAN_STATUSES) });
export const setAssetStageSchema = z.object({ assetId: z.uuid(), stage: z.enum(ASSET_STAGES), note: z.string().nullish() });
