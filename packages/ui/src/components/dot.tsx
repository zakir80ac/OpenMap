// REQ-UI-001 — Dot: state-coloured indicator with the 14px accent glow and an optional live pulse.
import type { ReactNode } from 'react';
import { cx, mergeStyle, px, type OmStyle } from '../style.js';
import { componentClasses } from '../tailwind-preset.js';
import { PULSE_ANIMATION, glow, stateColor, varRef, type UiState } from '../tokens/index.js';

export const DOT_SIZES = [6, 8, 10] as const;
export type DotSize = (typeof DOT_SIZES)[number];

export interface DotProps {
  state: UiState;
  size?: DotSize;
  /** Accent glow around the dot; on by default. */
  glowing?: boolean;
  /** Opacity pulse for live / streaming states. */
  pulse?: boolean;
  /** Accessible name; omit when the dot is decorative beside a label. */
  label?: string;
  className?: string | undefined;
  style?: OmStyle | undefined;
}

export function Dot({ state, size = 8, glowing = true, pulse = false, label, className, style }: DotProps): ReactNode {
  const accent = stateColor(state);
  const base: OmStyle = {
    '--om-dot-accent': accent,
    width: px(size),
    height: px(size),
    background: accent,
    boxShadow: glowing ? glow('bar', accent) : undefined,
    animation: pulse ? PULSE_ANIMATION + ' ' + varRef('pulse-period') + ' ' + varRef('ease-in-out') + ' infinite' : undefined,
  };
  return (
    <span
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? 'true' : undefined}
      data-state={state}
      data-pulse={pulse ? 'true' : undefined}
      className={cx('om-dot', componentClasses.dot, className)}
      style={mergeStyle(base, style)}
    />
  );
}
