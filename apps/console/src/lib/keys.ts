// REQ-UI-003 — maps contract enums to their i18n keys so every view labels layers and health states the same way.
import type { CiLayer } from '@openmap/contracts';
import type { MessageKey } from '@openmap/i18n';
import type { HealthState } from './queries';

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
