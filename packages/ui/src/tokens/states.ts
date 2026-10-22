// REQ-UI-001 — health-state colours shared by Dot, Tag, StateBadge and graph rendering.
import { accents, text, type HexColor } from './color.js';

/** Operational states a CI or service can be shown in. Order is worst to best for sorting. */
export const UI_STATES = ['down', 'degraded', 'at_risk', 'unknown', 'healthy'] as const;
export type UiState = (typeof UI_STATES)[number];

export const stateColors = {
  healthy: accents.emerald,
  degraded: accents.amber,
  down: accents.rose,
  unknown: text.secondary,
  at_risk: accents.violetLight,
} as const satisfies Record<UiState, HexColor>;

export function stateColor(state: UiState): HexColor {
  return stateColors[state];
}

export function isUiState(value: string): value is UiState {
  return (UI_STATES as readonly string[]).includes(value);
}
