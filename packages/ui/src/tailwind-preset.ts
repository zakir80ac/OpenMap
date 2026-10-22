// REQ-UI-001 — Tailwind v4 theme: tokens as `om-*` utilities (colors, radius, shadow, fonts, text sizes, spacing, motion).
import { accents, borders, ground, surfaces, text } from './tokens/color.js';
import { layerColors } from './tokens/layers.js';
import { duration, easing } from './tokens/motion.js';
import { radii } from './tokens/radii.js';
import { glows, shadows } from './tokens/shadows.js';
import { spacing } from './tokens/spacing.js';
import { stateColors } from './tokens/states.js';
import { fontFamily, fontSizePx } from './tokens/typography.js';

/** Utility prefix: `bg-om-surface1`, `text-om-primary`, `rounded-om-card`, `shadow-om-card`, `font-om-display`. */
export const UTILITY_PREFIX = 'om-';

function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

function prefixed<T extends Record<string, string | number>>(entries: T, sub = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    const name = UTILITY_PREFIX + (sub === '' ? '' : sub + '-') + kebab(key);
    out[name] = typeof value === 'number' ? String(value) + 'px' : value;
  }
  return out;
}

/** Colour utilities: `om-ground`, `om-surface1`, `om-primary`, `om-cyan`, `om-layer-dc`, `om-state-healthy`, `om-border-glass`. */
export const themeColors: Record<string, string> = {
  [UTILITY_PREFIX + 'ground']: ground,
  ...prefixed(surfaces),
  ...prefixed(text),
  ...prefixed(accents),
  ...prefixed(layerColors, 'layer'),
  ...prefixed(stateColors, 'state'),
  ...prefixed(borders, 'border'),
};

export const themeRadius: Record<string, string> = prefixed(radii);
export const themeShadow: Record<string, string> = { ...prefixed(shadows), ...prefixed(glows, 'glow') };
export const themeFontFamily: Record<string, string> = prefixed(fontFamily);
export const themeFontSize: Record<string, string> = prefixed(fontSizePx);
export const themeSpacing: Record<string, string> = prefixed(spacing);
export const themeDuration: Record<string, string> = prefixed(duration);
export const themeEasing: Record<string, string> = prefixed(easing);

/**
 * Theme object in the shape Tailwind's `theme.extend` accepts (v3 compatibility layer and tooling that
 * reads a JS theme). Tailwind v4 projects should prefer `themeCss()` and `@import` it.
 */
export const tailwindTheme = {
  colors: themeColors,
  borderRadius: themeRadius,
  boxShadow: themeShadow,
  fontFamily: themeFontFamily,
  fontSize: themeFontSize,
  spacing: themeSpacing,
  transitionDuration: themeDuration,
  transitionTimingFunction: themeEasing,
} as const;

export type TailwindTheme = typeof tailwindTheme;

/** Tailwind v4 `@theme` namespaces each group maps to. */
const namespaces = {
  colors: 'color',
  borderRadius: 'radius',
  boxShadow: 'shadow',
  fontFamily: 'font',
  fontSize: 'text',
  spacing: 'spacing',
  transitionDuration: 'duration',
  transitionTimingFunction: 'ease',
} as const satisfies Record<keyof TailwindTheme, string>;

/**
 * Generates the `@theme { ... }` block Tailwind v4 reads to create utilities. The console writes this to a
 * CSS file at build time (or imports it through a CSS plugin) and adds `@import "tailwindcss";` above it.
 */
export function themeCss(): string {
  const lines: string[] = [];
  for (const group of Object.keys(namespaces) as Array<keyof TailwindTheme>) {
    for (const [name, value] of Object.entries(tailwindTheme[group])) {
      lines.push('  --' + namespaces[group] + '-' + name + ': ' + value + ';');
    }
  }
  return '@theme {\n' + lines.join('\n') + '\n}\n';
}

/** Component class names → the utility set they expand to. Exported so consumers can safelist or audit them. */
export const componentClasses = {
  card: 'bg-om-surface1 border border-om-border-glass rounded-om-card shadow-om-card-with-highlight text-om-primary',
  glassPanel: 'bg-om-surface2 border border-om-border-glass rounded-om-panel-lg shadow-om-inner-highlight backdrop-blur-md',
  pill: 'inline-flex items-center gap-om-6 rounded-om-pill border font-om-body font-medium text-om-xs leading-none',
  tag: 'inline-flex items-center gap-om-6 rounded-om-tag border font-om-body font-medium text-om-2xs leading-none',
  dot: 'inline-block rounded-om-pill shrink-0',
  bar: 'relative overflow-hidden rounded-om-pill bg-om-surface3',
  kpi: 'flex flex-col gap-om-6',
  sectionTitle: 'font-om-display font-semibold text-om-primary',
} as const;

export type ComponentClassName = keyof typeof componentClasses;
