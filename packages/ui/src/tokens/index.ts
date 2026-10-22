// REQ-UI-001 — design tokens entry point (CLAUDE.md §9: components use these, never raw values).
export * from './color.js';
export * from './layers.js';
export * from './states.js';
export * from './typography.js';
export * from './radii.js';
export * from './spacing.js';
export * from './shadows.js';
export * from './motion.js';
export * from './css-variables.js';

import { colors } from './color.js';
import { directionVariables } from './css-variables.js';
import { layerColors } from './layers.js';
import { motion } from './motion.js';
import { radii } from './radii.js';
import { glows, shadows } from './shadows.js';
import { spacing } from './spacing.js';
import { stateColors } from './states.js';
import { typography } from './typography.js';

/** Every token group in one object, for consumers that want to iterate or serialise them. */
export const tokens = {
  colors,
  layers: layerColors,
  states: stateColors,
  typography,
  radii,
  spacing,
  shadows,
  glows,
  motion,
  direction: directionVariables,
} as const;

export type Tokens = typeof tokens;
