// REQ-UI-001 — emits the `--om-*` CSS custom properties for :root plus the small [dir] blocks that logical CSS cannot cover.
import { accents, borders, ground, surfaces, text, withAlpha } from './color.js';
import { aurora, grid, holoBorder, hudBracket, ring, rise, sheen, textGlow, valueGlow, float, floatHoverShadow, floatShadow } from './effects.js';
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
    // Horizon effects (REQ-UI-025): one gradient, one bracket colour, one grid, one sheen, read by the rules below.
    '  ' + cssVar('holo-border') + ': ' + holoBorder() + ';',
    '  ' + cssVar('holo-border-violet') + ': ' + holoBorder(accents.violet, accents.cyan) + ';',
    '  ' + cssVar('hud-bracket') + ': ' + withAlpha(accents.cyan, hudBracket.alpha) + ';',
    '  ' + cssVar('hud-bracket-length') + ': ' + String(hudBracket.lengthPx) + 'px;',
    '  ' + cssVar('hud-bracket-thickness') + ': ' + String(hudBracket.thicknessPx) + 'px;',
    '  ' + cssVar('hud-bracket-inset') + ': ' + String(hudBracket.insetPx) + 'px;',
    '  ' + cssVar('grid-cell') + ': ' + String(grid.cellPx) + 'px;',
    '  ' + cssVar('grid-line') + ': rgba(255,255,255,' + String(grid.lineAlpha) + ');',
    '  ' + cssVar('grid-floor-height') + ': ' + String(grid.floorHeightPercent) + 'vh;',
    '  ' + cssVar('grid-perspective') + ': ' + String(grid.perspectivePx) + 'px;',
    '  ' + cssVar('grid-tilt') + ': ' + String(grid.tiltDeg) + 'deg;',
    '  ' + cssVar('grid-drift-period') + ': ' + grid.driftPeriod + ';',
    '  ' + cssVar('aurora-cyan') + ': ' + withAlpha(accents.cyan, aurora.cyanAlpha) + ';',
    '  ' + cssVar('aurora-violet') + ': ' + withAlpha(accents.violet, aurora.violetAlpha) + ';',
    '  ' + cssVar('aurora-fuchsia') + ': ' + withAlpha(accents.fuchsia, aurora.fuchsiaAlpha) + ';',
    '  ' + cssVar('value-glow-cyan') + ': ' + valueGlow(accents.cyan) + ';',
    '  ' + cssVar('sheen-width') + ': ' + String(sheen.widthPercent) + '%;',
    '  ' + cssVar('sheen-color') + ': rgba(255,255,255,' + String(sheen.alpha) + ');',
    '  ' + cssVar('sheen-period') + ': ' + sheen.period + ';',
    '  ' + cssVar('rise-distance') + ': ' + String(rise.distancePx) + 'px;',
    '  ' + cssVar('rise-duration') + ': ' + rise.duration + ';',
    '  ' + cssVar('ring-scale') + ': ' + String(ring.scaleEnd) + ';',
    '  ' + cssVar('ring-period') + ': ' + ring.period + ';',
    // Floating surfaces (REQ-UI-032).
    '  ' + cssVar('float-shadow') + ': ' + floatShadow() + ';',
    '  ' + cssVar('float-shadow-hover') + ': ' + floatHoverShadow() + ';',
    '  ' + cssVar('float-lift') + ': ' + String(float.hoverLiftPx) + 'px;',
    '  ' + cssVar('float-idle-distance') + ': ' + String(float.idleDistancePx) + 'px;',
    '  ' + cssVar('float-period') + ': ' + float.idlePeriod + ';',
  ];
  const dirBlock = (dir: 'ltr' | 'rtl'): string =>
    '[dir=' + dir + '] {\n' + declarations(directionVariables[dir], 'dir').join('\n') + '\n}';
  return [':root {\n' + root.join('\n') + '\n}', dirBlock('ltr'), dirBlock('rtl')].join('\n\n') + '\n';
}

/** Name of the keyframes Dot and live Pills animate with. */
export const PULSE_ANIMATION = 'om-pulse';
/** Entrance of cards and panels. */
export const RISE_ANIMATION = 'om-rise';
/** Sheen travelling along a live bar. */
export const SHEEN_ANIMATION = 'om-sheen';
/** Ring expanding from a live dot. */
export const RING_ANIMATION = 'om-ring';
/** Slow drift of the perspective grid ground. */
export const GRID_DRIFT_ANIMATION = 'om-grid-drift';
/** Idle drift of a floating tile. */
export const FLOAT_ANIMATION = 'om-float';

/** The keyframes the components and the console ground need. Opacity and transform only, so they stay cheap. */
export function keyframesCss(): string {
  return [
    '@keyframes ' + PULSE_ANIMATION + ' {\n  0%, 100% { opacity: 1; }\n  50% { opacity: .35; }\n}',
    // Movement only, never opacity: Chrome counts no first contentful paint for content that started at opacity 0,
    // and a page whose text all sits in cards (the sign-in gate) would never get one (Lighthouse NO_FCP).
    '@keyframes ' + RISE_ANIMATION + ' {\n  from { transform: translateY(' + varRef('rise-distance') + '); }\n  to { transform: translateY(0); }\n}',
    '@keyframes ' + SHEEN_ANIMATION + ' {\n  from { transform: translateX(calc(-100% * ' + varRef('dir-flow-sign') + ')); }\n  to { transform: translateX(calc(300% * ' + varRef('dir-flow-sign') + ')); }\n}',
    '@keyframes ' + RING_ANIMATION + ' {\n  from { transform: scale(1); opacity: .8; }\n  to { transform: scale(' + varRef('ring-scale') + '); opacity: 0; }\n}',
    '@keyframes ' + FLOAT_ANIMATION + ' {\n  from { transform: translateY(0); }\n  to { transform: translateY(calc(-1 * ' + varRef('float-idle-distance') + ')); }\n}',
    // Transform only, so the drift runs on the compositor and never repaints the grid layer.
    '@keyframes ' + GRID_DRIFT_ANIMATION + ' {\n  from { transform: perspective(' + varRef('grid-perspective') + ') rotateX(' + varRef('grid-tilt') + ') translateY(0); }\n  to { transform: perspective(' + varRef('grid-perspective') + ') rotateX(' + varRef('grid-tilt') + ') translateY(' + varRef('grid-cell') + '); }\n}',
  ].join('\n') + '\n';
}

/**
 * Surface rules of the Horizon look (REQ-UI-025): a holographic gradient border painted under the surface colour
 * (background-clip keeps the border transparent), HUD corner brackets as a pseudo-element, the entrance rise, the
 * value glow on figures and the sheen on live bars. Unlayered, so they win over Tailwind's utility layer, and
 * every number comes from the variables above. Reduced motion turns every animation off.
 */
const PERCENT = 100;

export function componentRulesCss(): string {
  const bracketStroke = 'linear-gradient(' + varRef('hud-bracket') + ', ' + varRef('hud-bracket') + ')';
  const corner = (x: string, y: string): string =>
    bracketStroke + ' ' + x + ' ' + y + ' / ' + varRef('hud-bracket-length') + ' ' + varRef('hud-bracket-thickness') + ' no-repeat, ' +
    bracketStroke + ' ' + x + ' ' + y + ' / ' + varRef('hud-bracket-thickness') + ' ' + varRef('hud-bracket-length') + ' no-repeat';
  const brackets = [corner('left', 'top'), corner('right', 'top'), corner('left', 'bottom'), corner('right', 'bottom')].join(', ');
  return [
    '.om-card, .om-glass-panel {',
    '  position: relative;',
    '  border-color: transparent;',
    '  background-image: linear-gradient(' + varRef('surface1') + ', ' + varRef('surface1') + '), ' + varRef('holo-border') + ';',
    '  background-origin: padding-box, border-box;',
    '  background-clip: padding-box, border-box;',
    // backwards, not both: once the rise ends the card has no transform, so it forms no stacking context and a
    // dropdown inside it (z-indexed) can still paint over the cards that follow.
    '  animation: ' + RISE_ANIMATION + ' ' + varRef('rise-duration') + ' ' + varRef('ease-decelerate') + ' backwards;',
    '}',
    '.om-glass-panel {',
    '  background-image: linear-gradient(' + varRef('surface2') + ', ' + varRef('surface2') + '), ' + varRef('holo-border-violet') + ';',
    '}',
    '.om-card::after {',
    '  content: "";',
    '  position: absolute;',
    '  inset: ' + varRef('hud-bracket-inset') + ';',
    '  pointer-events: none;',
    '  background: ' + brackets + ';',
    '  opacity: .7;',
    '}',
    '.om-kpi [data-part="value"] > span:first-child {',
    '  text-shadow: 0 0 ' + String(textGlow.blurPx) + 'px color-mix(in srgb, var(--om-kpi-accent) ' + String(Math.round(textGlow.alpha * PERCENT)) + '%, transparent);',
    '}',
    '.om-bar [data-part="sheen"] {',
    '  position: absolute;',
    '  inset-block: 0;',
    '  inset-inline-start: 0;',
    '  width: ' + varRef('sheen-width') + ';',
    '  background: linear-gradient(' + varRef('dir-flow-angle') + ', transparent, ' + varRef('sheen-color') + ', transparent);',
    '  animation: ' + SHEEN_ANIMATION + ' ' + varRef('sheen-period') + ' linear infinite;',
    '  pointer-events: none;',
    '}',
    '.om-dot[data-pulse="true"]::after {',
    '  content: "";',
    '  position: absolute;',
    '  inset: 0;',
    '  border-radius: inherit;',
    '  border: 1px solid currentColor;',
    '  animation: ' + RING_ANIMATION + ' ' + varRef('ring-period') + ' ' + varRef('ease-decelerate') + ' infinite;',
    '}',
    // Floating surfaces (REQ-UI-032): opt-in, because a transform makes a stacking context and a card that holds a
    // dropdown must not float. Tiles with figures may also drift on an idle float.
    '.om-float {',
    '  box-shadow: ' + varRef('float-shadow') + ';',
    '  transition: transform ' + varRef('duration-base') + ' ' + varRef('ease-standard') + ', box-shadow ' + varRef('duration-base') + ' ' + varRef('ease-standard') + ';',
    '}',
    '.om-float:hover {',
    '  transform: translateY(calc(-1 * ' + varRef('float-lift') + '));',
    '  box-shadow: ' + varRef('float-shadow-hover') + ';',
    '}',
    '.om-float-idle {',
    '  animation: ' + RISE_ANIMATION + ' ' + varRef('rise-duration') + ' ' + varRef('ease-decelerate') + ' backwards, ' + FLOAT_ANIMATION + ' ' + varRef('float-period') + ' ' + varRef('ease-standard') + ' ' + varRef('rise-duration') + ' infinite alternate;',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  .om-card, .om-glass-panel, .om-bar [data-part="sheen"], .om-dot[data-pulse="true"]::after, .om-float-idle { animation: none; }',
    '  .om-float:hover { transform: none; }',
    '}',
  ].join('\n') + '\n';
}

/** Everything the console must inject once: variables, direction blocks, keyframes and the surface rules. */
export function stylesheet(): string {
  return cssVariables() + '\n' + keyframesCss() + '\n' + componentRulesCss();
}
