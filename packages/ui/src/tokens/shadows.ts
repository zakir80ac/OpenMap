// REQ-UI-001 — shadows, highlights and accent glows (bars, primary buttons, selected nav).
import { accents, withAlpha } from './color.js';

/** Hairline highlight along the top edge of glass surfaces. Combine with another shadow via a comma. */
export const innerHighlight = 'inset 0 1px 0 rgba(255,255,255,.05)' as const;

/** Deep drop shadow for cards floating over the ground. */
export const cardShadow = '0 30px 60px -30px rgba(0,0,0,.8)' as const;

export const shadows = {
  innerHighlight,
  card: cardShadow,
  cardWithHighlight: cardShadow + ', ' + innerHighlight,
} as const;

/** Alpha each glow kind uses, from the approved design. */
export const glowAlpha = {
  bar: 0.45,
  button: 0.8,
  nav: 0.7,
} as const;

export type GlowKind = keyof typeof glowAlpha;

/** Glow geometry per kind; `<accent>` is replaced by the accent at the kind's alpha. */
const glowShape: Record<GlowKind, (accent: string) => string> = {
  bar: (accent) => '0 0 14px ' + accent,
  button: (accent) => '0 12px 28px -10px ' + accent,
  nav: (accent) => '0 10px 30px -14px ' + accent,
};

/** Build the glow for an accent hex, e.g. `glow('bar', accents.cyan)` → `0 0 14px rgba(34,211,238,0.45)`. */
export function glow(kind: GlowKind, accentHex: string): string {
  return glowShape[kind](withAlpha(accentHex, glowAlpha[kind]));
}

/** Pre-built glows for the primary (cyan) and assistant (violet) accents. */
export const glows = {
  barCyan: glow('bar', accents.cyan),
  barViolet: glow('bar', accents.violet),
  buttonCyan: glow('button', accents.cyan),
  buttonViolet: glow('button', accents.violet),
  navCyan: glow('nav', accents.cyan),
  navViolet: glow('nav', accents.violet),
} as const;
