// REQ-BSM-006 REQ-BSM-008 — zod schemas for the SLA, availability and incident-response arguments (ADR-024).
import { SLA } from '@openmap/constants';
import { z } from 'zod';
import { healthStateSchema } from '../ci/ci.schemas.js';

export const incidentSeveritySchema = z.enum(['informational', 'low', 'medium', 'high', 'critical']);
export const slaWindowSchema = z.enum(SLA.windows);
export const granularitySchema = z.enum(SLA.granularities);

export const servicesArgsSchema = z.object({ health: z.array(healthStateSchema).nullish() });
export const incidentsArgsSchema = z.object({ open: z.boolean().nullish(), serviceId: z.uuid().nullish() });
export const reportArgsSchema = z.object({ incidentId: z.uuid(), integrationId: z.uuid() });
export const idSchema = z.uuid();

export const availabilityArgsSchema = z.object({
  granularity: granularitySchema,
  periods: z.number().int().min(1).max(SLA.maxPeriods).nullish(),
});

export const severityTargetInputSchema = z.object({
  severity: incidentSeveritySchema,
  respondMinutes: z.number().int().min(1).max(SLA.maxTargetMinutes),
  resolveMinutes: z.number().int().min(1).max(SLA.maxTargetMinutes),
});

export const slaInputSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().nullish(),
  availabilityTargetPercent: z.number().min(SLA.minTargetPercent).max(SLA.maxTargetPercent),
  window: slaWindowSchema,
  responseTargets: z.array(severityTargetInputSchema).nullish(),
  burnRateAlert: z.number().positive().nullish(),
});
export type SlaInput = z.infer<typeof slaInputSchema>;

export const upsertSlaArgsSchema = z.object({ id: z.uuid().nullish(), input: slaInputSchema });
export const assignSlaArgsSchema = z.object({ serviceId: z.uuid(), slaId: z.uuid().nullish() });
export const assignIncidentArgsSchema = z.object({
  incidentId: z.uuid(),
  assignee: z.string().trim().min(1),
});
export const resolveIncidentArgsSchema = z.object({ incidentId: z.uuid(), note: z.string().trim().min(1) });

export const correctiveActionInputSchema = z.object({
  description: z.string().trim().min(1),
  owner: z.string().trim().nullish(),
  dueAt: z.iso.datetime().nullish(),
  done: z.boolean().nullish(),
});

export const rcaInputSchema = z.object({
  summary: z.string().trim().min(1),
  rootCauseCiId: z.uuid().nullish(),
  contributingFactors: z.array(z.string().trim().min(1)).nullish(),
  correctiveActions: z.array(correctiveActionInputSchema).nullish(),
  owner: z.string().trim().nullish(),
  dueAt: z.iso.datetime().nullish(),
  completedAt: z.iso.datetime().nullish(),
});
export type RcaInput = z.infer<typeof rcaInputSchema>;

export const updateRcaArgsSchema = z.object({ incidentId: z.uuid(), input: rcaInputSchema });

/** The stored RCA JSON, validated on read so a malformed row degrades to null instead of breaking the list. */
export const rcaStoredSchema = z.object({
  summary: z.string(),
  rootCauseCiId: z.uuid().nullable(),
  contributingFactors: z.array(z.string()),
  correctiveActions: z.array(
    z.object({
      description: z.string(),
      owner: z.string().nullable(),
      dueAt: z.iso.datetime().nullable(),
      done: z.boolean(),
    }),
  ),
  owner: z.string().nullable(),
  dueAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  updatedBy: z.string(),
  updatedAt: z.iso.datetime(),
});
