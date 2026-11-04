// REQ-UI-001 REQ-UI-025 — Horizon effects: the holographic card border, HUD corner brackets, the perspective grid
// ground, value glows and the sheen that travels along live bars. Every value a component or the console stylesheet
// uses for the futuristic surface language lives here, so the look is one set of numbers, not scattered CSS.
import { accents, withAlpha } from './color.js';

/** Alphas of the holographic border gradient: strong at the inline start, fading past the middle. */
export const holoAlpha = {
  start: 0.55,
  middle: 0.3,
  end: 0.06,
} as const;

/** Gradient stops (percent along the diagonal) where the holographic border changes hue. */
export const holoStops = {
  middle: 45,
  end: 85,
} as const;

/** Angle of the holographic border; a diagonal reads the same in both directions. */
export const HOLO_ANGLE = '135deg';

/** The border gradient for a surface: cyan at the start, violet in the middle, almost nothing at the end. */
export function holoBorder(start: string = accents.cyan, middle: string = accents.violet): string {
  return (
    'linear-gradient(' +
    HOLO_ANGLE +
    ', ' +
    withAlpha(start, holoAlpha.start) +
    ', ' +
    withAlpha(middle, holoAlpha.middle) +
    ' ' +
    String(holoStops.middle) +
    '%, ' +
    withAlpha(start, holoAlpha.end) +
    ' ' +
    String(holoStops.end) +
    '%)'
  );
}

/** HUD corner brackets drawn on cards: length and thickness in px, alpha of the mark. */
export const hudBracket = {
  lengthPx: 14,
  thicknessPx: 1,
  alpha: 0.75,
  /** Inset from the card corner so the mark sits inside the rounded border. */
  insetPx: 6,
} as const;

/** The perspective grid behind the console: cell size, line alpha, how far up the page it reaches and its drift. */
export const grid = {
  cellPx: 56,
  lineAlpha: 0.055,
  /** Vertical extent of the grid floor as a percentage of the viewport height. */
  floorHeightPercent: 62,
  /** Perspective distance and tilt that make the floor recede. */
  perspectivePx: 900,
  tiltDeg: 62,
  /** One cell per drift period, slow enough to be felt rather than seen. */
  driftPeriod: '14s',
} as const;

/** Aurora glows behind the ground: alphas of the three washes. */
export const aurora = {
  cyanAlpha: 0.16,
  violetAlpha: 0.18,
  fuchsiaAlpha: 0.07,
} as const;

/** Glow behind large display values (KPIs, hero figures). */
export const textGlow = {
  blurPx: 22,
  alpha: 0.45,
} as const;

export function valueGlow(accent: string): string {
  return '0 0 ' + String(textGlow.blurPx) + 'px ' + withAlpha(accent, textGlow.alpha);
}

/** The sheen that sweeps a live bar: width as a share of the track, peak alpha, period. */
export const sheen = {
  widthPercent: 38,
  alpha: 0.28,
  period: '2.8s',
} as const;

/** Entrance of cards and panels: distance and duration of the rise. */
export const rise = {
  distancePx: 10,
  duration: '420ms',
  /** Stagger between sibling cards. */
  staggerMs: 40,
} as const;

/** Ring that expands from a live dot. */
export const ring = {
  scaleEnd: 2.4,
  period: '2.4s',
} as const;

export const effects = { holoAlpha, holoStops, hudBracket, grid, aurora, textGlow, sheen, rise, ring } as const;
