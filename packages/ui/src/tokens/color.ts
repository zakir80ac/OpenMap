// REQ-UI-001 — Obsidian Pro colour tokens: ground, surfaces, borders, text and accents (approved design, exact values).

/** A CSS hex colour such as `#22D3EE`. */
export type HexColor = `#${string}`;

/** Page background. Everything else sits on top of this. */
export const ground = '#070A12' as const satisfies HexColor;

/** Elevation steps. surface1 is a card, surface2 a panel on a card, surface3 a control on a panel. */
export const surfaces = {
  surface1: '#0E1322',
  surface2: '#141A2C',
  surface3: '#1B2238',
} as const satisfies Record<string, HexColor>;

/** Translucent borders over dark surfaces. */
export const borders = {
  glass: 'rgba(255,255,255,.07)',
  strong: 'rgba(255,255,255,.1)',
} as const;

export const text = {
  primary: '#EEF2FF',
  secondary: '#9AA3B8',
  /** Lifted from the approved #5E677C (3.3:1) to hold WCAG AA 4.5:1 for 11 px captions on every surface (REQ-UI-003 Lighthouse). */
  muted: '#848DA3',
} as const satisfies Record<string, HexColor>;

/**
 * Accent palette. The comment on each entry is its semantic job in the console; components use the
 * semantic aliases below rather than picking an accent by hue.
 */
export const accents = {
  /** live / network / primary action */
  cyan: '#22D3EE',
  /** time travel / assistant */
  violet: '#8B5CF6',
  /** lighter violet used for storage layer and at_risk state */
  violetLight: '#A78BFA',
  /** warning */
  amber: '#F5B82E',
  /** failure */
  rose: '#FB5B7A',
  /** healthy */
  emerald: '#2DD4A0',
  /** containers */
  sky: '#38BDF8',
  /** cloud */
  blue: '#60A5FA',
  /** operating systems */
  lime: '#A3E635',
  /** databases */
  orange: '#FB923C',
  /** saas */
  fuchsia: '#E879F9',
  /** hardware */
  steel: '#C7CEE0',
} as const satisfies Record<string, HexColor>;

/**
 * Accent tints that fall under 4.5:1 as small text on a tinted panel (violet 3.8:1, rose 4.4:1) are swapped for a
 * lighter text variant by `readableAccent`; every other accent already clears AA on every surface.
 */
export const accentText = {
  [accents.violet]: '#A78BFA',
  [accents.rose]: '#FD7F97',
} as const satisfies Record<string, HexColor>;

/** The colour to paint small text in when a component is tinted with `accent`. */
export function readableAccent(accent: string): string {
  return (accentText as Record<string, string>)[accent] ?? accent;
}

export type AccentName = keyof typeof accents;

/** Semantic aliases so call sites say what they mean. */
export const semantic = {
  primary: accents.cyan,
  live: accents.cyan,
  assistant: accents.violet,
  timeTravel: accents.violet,
  warning: accents.amber,
  failure: accents.rose,
  healthy: accents.emerald,
  neutral: text.secondary,
} as const satisfies Record<string, HexColor>;

export const colors = {
  ground,
  ...surfaces,
  ...text,
  ...accents,
  borderGlass: borders.glass,
  borderStrong: borders.strong,
} as const;

export type ColorName = keyof typeof colors;

const HEX_RADIX = 16;
const SHORT_HEX_LENGTH = 3;
const LONG_HEX_LENGTH = 6;

/** Parse `#RGB` or `#RRGGBB` into channels. Throws on anything else so a bad token fails at build time, not in a browser. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const body = hex.startsWith('#') ? hex.slice(1) : hex;
  const full =
    body.length === SHORT_HEX_LENGTH
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  if (full.length !== LONG_HEX_LENGTH || !/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error('hexToRgb: expected #RGB or #RRGGBB, got ' + hex);
  }
  return {
    r: Number.parseInt(full.slice(0, 2), HEX_RADIX),
    g: Number.parseInt(full.slice(2, 4), HEX_RADIX),
    b: Number.parseInt(full.slice(4, 6), HEX_RADIX),
  };
}

/** `withAlpha('#22D3EE', 0.45)` → `rgba(34,211,238,0.45)`. Used for glows and tinted backgrounds. */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return 'rgba(' + String(r) + ',' + String(g) + ',' + String(b) + ',' + String(alpha) + ')';
}
