// REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 (ADR-035) — zod schemas for the commercial queries and mutations;
// the record inputs themselves are the contract's (`contractInputSchema`, `vendorInputSchema`, `costCentreInputSchema`).
import { z } from 'zod';
import { CONTRACT_KINDS, contractInputSchema, costCentreInputSchema, vendorInputSchema } from '@openmap/contracts';

const trimmed = z.string().trim().min(1);

export const contractFilterSchema = z.object({
  kinds: z.array(z.enum(CONTRACT_KINDS)).nullish(),
  vendorId: z.uuid().nullish(),
  costCentreId: z.uuid().nullish(),
  text: z.string().nullish(),
  expiringWithinDays: z.number().int().min(0).nullish(),
  expired: z.boolean().nullish(),
});
export type ContractFilterInput = z.infer<typeof contractFilterSchema>;

export const upsertContractArgsSchema = z.object({ id: z.uuid().nullish(), input: contractInputSchema });
export const upsertVendorArgsSchema = z.object({ id: z.uuid().nullish(), input: vendorInputSchema });
export const upsertCostCentreArgsSchema = z.object({ id: z.uuid().nullish(), input: costCentreInputSchema });

export const vendorContactInputSchema = z.object({
  id: z.uuid().nullish(),
  vendorId: z.uuid(),
  name: trimmed,
  role: trimmed,
  email: z.email().nullish(),
  phone: trimmed.nullish(),
  portalUrl: trimmed.nullish(),
  availability: trimmed.nullish(),
  escalationLevel: z.number().int().min(1),
});
export type VendorContactInput = z.infer<typeof vendorContactInputSchema>;

export const setAssetContractArgsSchema = z.object({ assetId: z.uuid(), contractId: z.uuid().nullable() });
