// REQ-UI-001 REQ-UI-034 — surface effects, formal profile (ADR-022): a card rests on a layered shadow and lifts a
// little on hover; a live dot pulses. The holographic borders, HUD corner brackets, perspective grid floor, aurora
// washes, bar sheens, value glows and entrance rises of the first Horizon pass are gone: the customer read them as
// game-inspired. Every value the rules use lives here, so the look stays one set of numbers.
import { accents, withAlpha } from './color.js';

/**
 * Floating surfaces: a layered ambient + key shadow lifts a card off the ground; hover lifts it a little further and
 * outlines it with a faint accent. Transform only, so it stays on the compositor. Opt-in (`om-float`), because a
 * transform makes a stacking context and a card that holds a dropdown must not float.
 */
export const float = {
  /** Ambient (wide, soft) and key (tight) shadow layers, px and alpha. */
  ambientOffsetPx: 20,
  ambientBlurPx: 40,
  ambientSpreadPx: -16,
  ambientAlpha: 0.5,
  keyOffsetPx: 6,
  keyBlurPx: 14,
  keySpreadPx: -8,
  keyAlpha: 0.35,
  /** Hover: how far the surface rises and the accent outline and halo around it. */
  hoverLiftPx: 2,
  outlineAlpha: 0.18,
  haloAlpha: 0.1,
  haloBlurPx: 32,
  haloOffsetPx: 14,
  haloSpreadPx: -12,
} as const;

function layer(offset: number, blur: number, spread: number, color: string): string {
  return '0 ' + String(offset) + 'px ' + String(blur) + 'px ' + String(spread) + 'px ' + color;
}

/** The resting float shadow: ambient under key. */
export function floatShadow(): string {
  return layer(float.ambientOffsetPx, float.ambientBlurPx, float.ambientSpreadPx, 'rgba(0,0,0,' + String(float.ambientAlpha) + ')') + ', ' + layer(float.keyOffsetPx, float.keyBlurPx, float.keySpreadPx, 'rgba(0,0,0,' + String(float.keyAlpha) + ')');
}

/** The hover shadow: the resting layers plus a thin accent outline and a faint accent halo. */
export function floatHoverShadow(accent: string = accents.cyan): string {
  return '0 0 0 1px ' + withAlpha(accent, float.outlineAlpha) + ', ' + floatShadow() + ', ' + layer(float.haloOffsetPx, float.haloBlurPx, float.haloSpreadPx, withAlpha(accent, float.haloAlpha));
}

export const effects = { float } as const;
