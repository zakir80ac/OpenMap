// REQ-BSM-003 — zod schema for ScenarioInput.
import { z } from 'zod';
import { scenarioKindSchema } from '@openmap/contracts';

export const scenarioInputSchema = z.object({
  name: z.string().min(1),
  kind: scenarioKindSchema,
  failedCiIds: z.array(z.uuid()).min(1),
  maxDepth: z.number().int().min(0).nullish(),
  honourRedundancy: z.boolean().nullish(),
  includeSharedServices: z.boolean().nullish(),
  at: z.iso.datetime({ offset: true }).nullish(),
  /** REQ-BSM-005 (ADR-048): the runbook to follow if the scenario happens for real. */
  runbookId: z.uuid().nullish(),
});
export type ScenarioInput = z.infer<typeof scenarioInputSchema>;
