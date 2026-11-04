// REQ-UI-001 — typography tokens: families (names only; the console loads the fonts), weights, scale, tracking.

/**
 * Family names only. Loading Chakra Petch / Manrope / Inter / JetBrains Mono (Google Fonts or self-hosted) is the
 * console's responsibility so this package never performs or references a network fetch.
 */
export const fontFamily = {
  /** Horizon (REQ-UI-025): a squared, HUD-like display face for headings and figures; Manrope stays as the fallback. */
  display: "'Chakra Petch', 'Manrope', 'Inter', system-ui, sans-serif",
  body: "'Inter', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

export type FontFamilyName = keyof typeof fontFamily;

/** Weights the design uses; display 500–800, body 400/500/600. */
export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
} as const;

/** The twelve-step pixel scale from the approved design. Keys are stable names, values are px. */
export const fontSizePx = {
  '2xs': 11,
  xs: 12,
  'xs-plus': 12.5,
  sm: 13,
  'sm-plus': 13.5,
  md: 15,
  lg: 18,
  xl: 22,
  '2xl': 26,
  '3xl': 28,
  '4xl': 32,
  '5xl': 40,
} as const;

export type FontSizeName = keyof typeof fontSizePx;

/** Sizes at or above this use the display family and tight tracking. */
export const DISPLAY_MIN_PX = 22;

/** Negative tracking for display sizes: tighter as the size grows (-0.02em at 22px to -0.04em at 40px). */
export const letterSpacing = {
  body: '0',
  displayTight: '-0.02em',
  displayTighter: '-0.03em',
  displayTightest: '-0.04em',
} as const;

const TRACKING_TIGHTER_MIN_PX = 28;
const TRACKING_TIGHTEST_MIN_PX = 40;

/** Pick the tracking a display size should use. Body sizes get none. */
export function displayLetterSpacing(px: number): (typeof letterSpacing)[keyof typeof letterSpacing] {
  if (px >= TRACKING_TIGHTEST_MIN_PX) return letterSpacing.displayTightest;
  if (px >= TRACKING_TIGHTER_MIN_PX) return letterSpacing.displayTighter;
  if (px >= DISPLAY_MIN_PX) return letterSpacing.displayTight;
  return letterSpacing.body;
}

export const lineHeight = {
  tight: 1.1,
  snug: 1.25,
  normal: 1.45,
} as const;

export const typography = { fontFamily, fontWeight, fontSizePx, letterSpacing, lineHeight } as const;
