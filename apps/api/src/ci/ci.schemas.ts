// REQ-CMDB-001 — zod schemas for CMDB GraphQL inputs. Enumerations come from the contract so a
// filter can never name a type or layer the CMDB does not know.
import { z } from 'zod';
import {
  CI_CODE_PATTERN,
  attributesSchema,
  ciLayerSchema,
  ciTypeSchema,
  lifecycleSchema,
  relationshipTypeSchema,
  scalarSchema,
} from '@openmap/contracts';
import { BSM } from '@openmap/constants';

export const healthStateSchema = z.enum(BSM.healthOrder);
export const directionSchema = z.enum(['upstream', 'downstream', 'both']);

export const ciFilterSchema = z.object({
  types: z.array(ciTypeSchema).nullish(),
  layers: z.array(ciLayerSchema).nullish(),
  lifecycle: z.array(lifecycleSchema).nullish(),
  tags: z.array(z.string().min(1)).nullish(),
  siteId: z.uuid().nullish(),
  text: z.string().nullish(),
  attributeEquals: z.record(z.string().min(1), scalarSchema).nullish(),
  health: z.array(healthStateSchema).nullish(),
  asOf: z.iso.datetime({ offset: true }).nullish(),
});
export type CiFilterInput = z.infer<typeof ciFilterSchema>;

export const pagingSchema = z.object({
  first: z.number().int().nullish(),
  after: z.string().min(1).nullish(),
});

export const labelCiSchema = z.object({
  ciId: z.uuid(),
  title: z.string().min(1),
  description: z.string(),
  layer: ciLayerSchema,
  type: ciTypeSchema.nullish(),
});
export type LabelCiInput = z.infer<typeof labelCiSchema>;

/** REQ-CMDB-037 — a new short code: trimmed, upper-cased, then held to the contract's code pattern. */
export const setCiCodeSchema = z.object({
  ciId: z.uuid(),
  code: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.toUpperCase())
    .pipe(
      z
        .string()
        .regex(
          CI_CODE_PATTERN,
          'code must be a layer prefix, a dash and a slug of letters, digits and dashes',
        ),
    ),
});

export const updateAttributesSchema = z.object({
  ciId: z.uuid(),
  attributes: attributesSchema,
});

export const createRelationshipSchema = z.object({
  type: relationshipTypeSchema,
  fromCiId: z.uuid(),
  toCiId: z.uuid(),
  attributes: attributesSchema.nullish(),
});

export const relationshipArgsSchema = z.object({
  direction: directionSchema.nullish(),
  types: z.array(relationshipTypeSchema).nullish(),
  first: z.number().int().nullish(),
  after: z.string().min(1).nullish(),
});

export const searchArgsSchema = z.object({
  text: z.string().min(1),
  layers: z.array(ciLayerSchema).nullish(),
  first: z.number().int().nullish(),
});

export const historyArgsSchema = z.object({
  from: z.iso.datetime({ offset: true }).nullish(),
  to: z.iso.datetime({ offset: true }).nullish(),
});

export const vulnerabilityArgsSchema = z.object({
  minCvss: z.number().nullish(),
  internetFacing: z.boolean().nullish(),
});
