// REQ-UI-001 — emits the `--om-*` CSS custom properties for :root plus the small [dir] blocks that logical CSS cannot cover.
import { accents, borders, ground, surfaces, text } from './color.js';
import { float, floatHoverShadow, floatShadow } from './effects.js';
import { layerColors } from './layers.js';
import { duration, easing, pulsePeriod } from './motion.js';
import { radii } from './radii.js';
import { glows, shadows } from './shadows.js';
import { spacing } from './spacing.js';
import { stateColors } from './states.js';
import { fontFamily, fontSizePx, letterSpacing } from './typography.js';

/** Prefix for every custom property this package emits. */
export const CSS_VAR_PREFIX = '--om-';

export function cssVar(name: string): `--om-${string}` {
  return `${CSS_VAR_PREFIX}${name}`;
}

/** `var(--om-<name>)`, for inline styles that must reference a token through the cascade. */
export function varRef(name: string): string {
  return 'var(' + cssVar(name) + ')';
}

function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

function declarations(entries: Record<string, string | number>, group: string): string[] {
  return Object.entries(entries).map(([key, value]) => {
    const px = typeof value === 'number' ? String(value) + 'px' : value;
    const name = group === '' ? kebab(key) : group + '-' + kebab(key);
    return '  ' + cssVar(name) + ': ' + px + ';';
  });
}

/**
 * Direction-dependent values.
 *
 * Nearly everything in this system is direction-agnostic because components use logical properties
 * (`margin-inline`, `padding-inline`, `inset-inline-start`, `border-start-start-radius`, `text-align: start`)
 * which the browser flips for `[dir=rtl]` on its own. The only things logical properties cannot express
 * are angles and signs: a gradient that should travel in reading direction, a transform that should move
 * towards the inline end, and the origin a progress fill grows from. Those three read these variables.
 */
export const directionVariables = {
  ltr: {
    /** 1 in ltr, -1 in rtl; multiply an x-translation by it. */
    'flow-sign': '1',
    /** gradient angle that runs in reading direction */
    'flow-angle': '90deg',
    /** physical side the inline start resolves to, for `transform-origin` */
    'inline-start': 'left',
    'inline-end': 'right',
  },
  rtl: {
    'flow-sign': '-1',
    'flow-angle': '270deg',
    'inline-start': 'right',
    'inline-end': 'left',
  },
} as const;

export type DirectionVariableName = keyof (typeof directionVariables)['ltr'];

/**
 * Returns a stylesheet string: one `:root { ... }` block with every token as `--om-*`, followed by
 * `[dir=ltr]` and `[dir=rtl]` blocks that only hold the four direction variables above.
 * The console injects this once in its root layout.
 */
export function cssVariables(): string {
  const root: string[] = [
    '  ' + cssVar('ground') + ': ' + ground + ';',
    ...declarations(surfaces, ''),
    ...declarations(borders, 'border'),
    ...declarations(text, 'text'),
    ...declarations(accents, 'accent'),
    ...declarations(layerColors, 'layer'),
    ...declarations(stateColors, 'state'),
    ...declarations(fontFamily, 'font'),
    ...declarations(fontSizePx, 'text-size'),
    ...declarations(letterSpacing, 'tracking'),
    ...declarations(radii, 'radius'),
    ...declarations(spacing, 'space'),
    ...declarations(shadows, 'shadow'),
    ...declarations(glows, 'glow'),
    ...declarations(duration, 'duration'),
    ...declarations(easing, 'ease'),
    '  ' + cssVar('pulse-period') + ': ' + pulsePeriod + ';',
    // Floating surfaces (REQ-UI-034, formal profile).
    '  ' + cssVar('float-shadow') + ': ' + floatShadow() + ';',
    '  ' + cssVar('float-shadow-hover') + ': ' + floatHoverShadow() + ';',
    '  ' + cssVar('float-lift') + ': ' + String(float.hoverLiftPx) + 'px;',
  ];
  const dirBlock = (dir: 'ltr' | 'rtl'): string =>
    '[dir=' + dir + '] {\n' + declarations(directionVariables[dir], 'dir').join('\n') + '\n}';
  return [':root {\n' + root.join('\n') + '\n}', dirBlock('ltr'), dirBlock('rtl')].join('\n\n') + '\n';
}

/** Name of the keyframes Dot and live Pills animate with. */
export const PULSE_ANIMATION = 'om-pulse';

/** The keyframes the components need: opacity only, so it stays cheap. */
export function keyframesCss(): string {
  return '@keyframes ' + PULSE_ANIMATION + ' {\n  0%, 100% { opacity: 1; }\n  50% { opacity: .35; }\n}\n';
}

/**
 * Surface rules of the formal profile (REQ-UI-034, ADR-022): cards are plain bordered surfaces; a surface that opts
 * in with `om-float` rests on the layered shadow and lifts on hover. Unlayered, so they win over Tailwind's utility
 * layer, and every number comes from the variables above. Reduced motion removes the lift and the pulse.
 */
export function componentRulesCss(): string {
  return [
    '.om-card, .om-glass-panel {',
    '  position: relative;',
    '}',
    '.om-float {',
    '  box-shadow: ' + varRef('float-shadow') + ';',
    '  transition: transform ' + varRef('duration-base') + ' ' + varRef('ease-standard') + ', box-shadow ' + varRef('duration-base') + ' ' + varRef('ease-standard') + ';',
    '}',
    '.om-float:hover {',
    '  transform: translateY(calc(-1 * ' + varRef('float-lift') + '));',
    '  box-shadow: ' + varRef('float-shadow-hover') + ';',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  .om-float:hover { transform: none; }',
    '  .om-dot { animation: none; }',
    '}',
  ].join('\n') + '\n';
}

/** Everything the console must inject once: variables, direction blocks, keyframes and the surface rules. */
export function stylesheet(): string {
  return cssVariables() + '\n' + keyframesCss() + '\n' + componentRulesCss();
}
