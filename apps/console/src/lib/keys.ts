// REQ-UI-003 — maps contract enums to their i18n keys so every view labels layers and health states the same way.
import type { CiLayer, HeadlineMetricKey } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import { isRelationshipType, type RelationshipFamily } from './graph-layout';
import type { HealthState, PredictedState } from './queries';

export const healthKey = {
  healthy: 'health.healthy',
  degraded: 'health.degraded',
  down: 'health.down',
  unknown: 'health.unknown',
} as const satisfies Record<HealthState, MessageKey>;

/** Every CiLayer has a `layer.<name>` entry in both catalogues; the template type makes a missing one a compile error. */
export function layerKey(layer: CiLayer): MessageKey {
  return `layer.${layer}`;
}

/** REQ-CMDB-038 — every headline metric key of LAYER_HEADLINE_METRIC has a `metric.<key>` entry in both catalogues. */
export function metricKey(key: HeadlineMetricKey): MessageKey {
  return `metric.${key}`;
}

export const predictedKey = {
  down: 'impact.predicted.down',
  degraded: 'impact.predicted.degraded',
  at_risk: 'impact.predicted.at_risk',
  unaffected: 'impact.predicted.unaffected',
} as const satisfies Record<PredictedState, MessageKey>;

/** Every contract relationship type has a `relationship.<type>` entry; unknown types from the API fall back to `relationship.other`. */
export function relationshipKey(type: string): MessageKey {
  return isRelationshipType(type) ? `relationship.${type}` : 'relationship.other';
}

export function relationshipFamilyKey(family: RelationshipFamily): MessageKey {
  return `dependencies.family.${family}`;
}
