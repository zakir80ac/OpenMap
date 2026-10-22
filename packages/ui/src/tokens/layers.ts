// REQ-UI-001 — layer colours: one accent per CI layer in @openmap/contracts CI_LAYERS (compile-time complete).
import type { CiLayer } from '@openmap/contracts';
import { accents, text, type HexColor } from './color.js';

/**
 * `satisfies Record<CiLayer, HexColor>` means adding a layer to the contract without a colour here
 * is a type error, and the tokens test re-checks it at runtime against CI_LAYERS.
 */
export const layerColors = {
  dc: accents.amber,
  network_security: accents.cyan,
  hardware: accents.steel,
  storage: accents.violetLight,
  virtualization: accents.emerald,
  cloud: accents.blue,
  os: accents.lime,
  containers: accents.sky,
  databases: accents.orange,
  applications: accents.rose,
  saas: accents.fuchsia,
  unknown: text.secondary,
} as const satisfies Record<CiLayer, HexColor>;

export type LayerName = keyof typeof layerColors;

export function layerColor(layer: LayerName): HexColor {
  return layerColors[layer];
}
