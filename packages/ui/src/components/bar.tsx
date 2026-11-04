// REQ-UI-001 — Bar: progress bar whose fill grows from the inline start, so it flips in rtl; a glow on request.
import type { ReactNode } from 'react';
import { useDirection } from '../direction.js';
import { cx, mergeStyle, percent, px, type OmStyle } from '../style.js';
import { componentClasses } from '../tailwind-preset.js';
import { accents, directionVariables, glow, transition, varRef, withAlpha, type HexColor } from '../tokens/index.js';

export interface BarProps {
  /** Current value, clamped to 0..max. */
  value: number;
  max?: number;
  /** Fill accent; defaults to cyan (live / primary). */
  accent?: HexColor;
  /** Track thickness in px. */
  height?: number;
  glowing?: boolean;
  /** Accessible name for the progressbar. */
  label?: string;
  className?: string;
  style?: OmStyle;
}

const DEFAULT_MAX = 100;
const DEFAULT_HEIGHT = 6;
const FILL_START_ALPHA = 0.7;

export function Bar({
  value,
  max = DEFAULT_MAX,
  accent = accents.cyan,
  height = DEFAULT_HEIGHT,
  glowing = false,
  label,
  className,
  style,
}: BarProps): ReactNode {
  const dir = useDirection();
  const flow = directionVariables[dir];
  const width = percent(value, max);
  const clamped = Math.min(Math.max(value, 0), max);
  const base: OmStyle = {
    '--om-bar-accent': accent,
    '--om-flow-angle': flow['flow-angle'],
    height: px(height),
    background: varRef('surface3'),
  };
  const fill: OmStyle = {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: 0,
    width,
    borderRadius: 'inherit',
    background: 'linear-gradient(' + flow['flow-angle'] + ', ' + withAlpha(accent, FILL_START_ALPHA) + ', ' + accent + ')',
    boxShadow: glowing ? glow('bar', accent) : undefined,
    transformOrigin: flow['inline-start'] + ' center',
    transition: transition(['width'], 'slow'),
  };
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={clamped}
      dir={dir}
      data-dir={dir}
      className={cx('om-bar', componentClasses.bar, className)}
      style={mergeStyle(base, style)}
    >
      <span data-part="fill" data-origin={flow['inline-start']} style={fill} />
    </div>
  );
}
