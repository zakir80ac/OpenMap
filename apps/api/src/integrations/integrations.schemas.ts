// REQ-INT-005 — zod schema for IntegrationInput, built from the contract enumerations.
import { z } from 'zod';
import { DIRECTIONS, eventTypeSchema, integrationCategorySchema, integrationVendorSchema } from '@openmap/contracts';

export const fieldMappingSchema = z.object({ from: z.string().min(1), to: z.string().min(1), direction: z.enum(['out', 'in']) });
export const classMappingSchema = z.object({ ciType: z.string().min(1), remoteClass: z.string().min(1) });

export const integrationInputSchema = z.object({
  category: integrationCategorySchema,
  vendor: integrationVendorSchema,
  name: z.string().min(1),
  endpoint: z.url(),
  credentialRef: z.string().min(1),
  direction: z.enum(DIRECTIONS),
  settings: z.record(z.string(), z.unknown()).nullish(),
  fieldMappings: z.array(fieldMappingSchema).nullish(),
  classMappings: z.array(classMappingSchema).nullish(),
  subscribedEvents: z.array(eventTypeSchema).nullish(),
});
export type IntegrationInput = z.infer<typeof integrationInputSchema>;
