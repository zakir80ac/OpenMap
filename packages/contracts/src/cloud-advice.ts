// REQ-AI-005 (ADR-054) — cloud recommendations: what the model can advise for a cloud resource.
import { z } from 'zod';

/**
 * - release_stopped: stopped but still billed (attached disks, reserved addresses, licences);
 * - decommission_idle: running compute whose peak load stays at CLOUD_ADVICE.idlePeakPercent or under;
 * - downsize: running compute that never comes near its size;
 * - upsize: running compute that runs hot.
 */
export const CLOUD_RECOMMENDATION_KINDS = ['release_stopped', 'decommission_idle', 'downsize', 'upsize'] as const;
export const cloudRecommendationKindSchema = z.enum(CLOUD_RECOMMENDATION_KINDS);
export type CloudRecommendationKind = z.infer<typeof cloudRecommendationKindSchema>;
