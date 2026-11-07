// REQ-BSM-005 (ADR-048) — zod schemas for RunbookInput and the step-run arguments. Step orders are unique and the
// catalogue code is the runbook's handle in the tenant.
import { RUNBOOKS } from '@openmap/constants';
import { runbookSchema } from '@openmap/contracts';
import { z } from 'zod';

export const runbookInputSchema = z
  .object({
    code: z.string().trim().min(1),
    title: z.string().trim().min(1),
    ownerTeam: z.string().trim().min(1),
    lastReviewedAt: z.iso.date().nullish(),
    steps: z
      .array(
        z.object({
          order: z.number().int().positive(),
          instruction: z.string().trim().min(1),
          estimatedMinutes: z.number().int().min(0).nullish(),
          automation: z.object({ integrationId: z.uuid(), action: z.string().trim().min(1) }).nullish(),
        }),
      )
      .min(1)
      .max(RUNBOOKS.maxSteps),
  })
  .refine((r) => new Set(r.steps.map((s) => s.order)).size === r.steps.length, { message: 'step orders must be unique', path: ['steps'] })
  .transform((r) => ({
    ...r,
    lastReviewedAt: r.lastReviewedAt ?? null,
    steps: [...r.steps]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ order: s.order, instruction: s.instruction, estimatedMinutes: s.estimatedMinutes ?? null, automation: s.automation ?? null })),
  }))
  .pipe(runbookSchema);
export type RunbookInput = z.infer<typeof runbookInputSchema>;

export const runStepArgsSchema = z.object({
  incidentId: z.uuid(),
  order: z.number().int().positive(),
  note: z.string().trim().max(RUNBOOKS.maxNoteLength).nullish(),
});
