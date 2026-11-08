// REQ-AI-003 (ADR-053) — anomaly rules over discovery and health events: the rules, the shape of a finding, and the
// ground truth a synthetic estate records for the anomalies it plants.
import { z } from 'zod';

/**
 * - ip_conflict: one address claimed (uses_ip) by two or more current CIs.
 * - unmanaged_device_in_datacenter: a device discovery could only call unknown, unlabelled, located in a data centre
 *   or colocation site: unmanaged equipment where only managed equipment belongs.
 * - flapping_service: a business service whose health changed ANOMALY.flapChanges times or more within
 *   ANOMALY.flapWindowHours.
 */
export const ANOMALY_RULES = ['ip_conflict', 'unmanaged_device_in_datacenter', 'flapping_service'] as const;
export const anomalyRuleSchema = z.enum(ANOMALY_RULES);
export type AnomalyRule = z.infer<typeof anomalyRuleSchema>;

/** One fact behind a finding, shown with it and given to the explanation. */
export const anomalyFactSchema = z.object({ key: z.string().min(1), value: z.string() });
export type AnomalyFact = z.infer<typeof anomalyFactSchema>;

export const anomalyFindingSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  rule: anomalyRuleSchema,
  /** The CI the finding is about: the address, the device or the service. */
  subjectCiId: z.uuid(),
  facts: z.array(anomalyFactSchema),
  state: z.enum(['open', 'cleared']),
  detectedAt: z.iso.datetime(),
  clearedAt: z.iso.datetime().nullable(),
  explanation: z.string().nullable(),
});
export type AnomalyFinding = z.infer<typeof anomalyFindingSchema>;

/** An anomaly a synthetic estate planted: the rule that should flag it and the subject's name. */
export const plantedAnomalySchema = z.object({ rule: anomalyRuleSchema, subject: z.string().min(1) });
export type PlantedAnomaly = z.infer<typeof plantedAnomalySchema>;
