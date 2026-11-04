// REQ-UI-001 — Pill: rounded chip in default, primary (cyan), violet and time-travel (dashed violet gradient) variants.
import type { MouseEventHandler, ReactNode } from 'react';
import { useDirection } from '../direction.js';
import { cx, mergeStyle, type OmStyle } from '../style.js';
import { componentClasses } from '../tailwind-preset.js';
import { accents, glow, text, varRef, withAlpha, type HexColor, readableAccent } from '../tokens/index.js';

export const PILL_VARIANTS = ['default', 'primary', 'violet', 'time-travel'] as const;
export type PillVariant = (typeof PILL_VARIANTS)[number];

export interface PillProps {
  children: ReactNode;
  variant?: PillVariant;
  /** Leading slot, e.g. a Dot. */
  icon?: ReactNode;
  /** Accent glow (0 0 14px). On by default for primary, violet and time-travel. */
  glowing?: boolean;
  /** Renders a button instead of a span. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  selected?: boolean;
  className?: string;
  style?: OmStyle;
}

const TINT_ALPHA = 0.14;
const BORDER_ALPHA = 0.35;
const GRADIENT_END_ALPHA = 0.22;

const variantAccent: Record<PillVariant, HexColor> = {
  default: text.secondary,
  primary: accents.cyan,
  violet: accents.violet,
  'time-travel': accents.violet,
};

export function Pill({ children, variant = 'default', icon, glowing, onClick, selected = false, className, style }: PillProps): ReactNode {
  const dir = useDirection();
  const accent = variantAccent[variant];
  const isAccent = variant !== 'default';
  const showGlow = glowing ?? false;
  const base: OmStyle = {
    '--om-pill-accent': accent,
    paddingInline: varRef('space-10'),
    paddingBlock: varRef('space-4'),
    color: isAccent ? readableAccent(accent) : varRef('text-secondary'),
    borderStyle: variant === 'time-travel' ? 'dashed' : 'solid',
    borderColor: isAccent ? withAlpha(accent, BORDER_ALPHA) : varRef('border-strong'),
    background:
      variant === 'time-travel'
        ? 'linear-gradient(' +
          varRef('dir-flow-angle') +
          ', ' +
          withAlpha(accents.violet, TINT_ALPHA) +
          ', ' +
          withAlpha(accents.violetLight, GRADIENT_END_ALPHA) +
          ')'
        : isAccent
          ? withAlpha(accent, TINT_ALPHA)
          : varRef('surface3'),
    boxShadow: showGlow ? glow(selected ? 'nav' : 'bar', accent) : undefined,
    transition: varRef('duration-base'),
    cursor: onClick === undefined ? undefined : 'pointer',
  };
  const classes = cx('om-pill', componentClasses.pill, className);
  const content = (
    <>
      {icon !== undefined ? <span data-part="icon">{icon}</span> : null}
      <span data-part="label">{children}</span>
    </>
  );
  if (onClick !== undefined) {
    return (
      <button
        type="button"
        dir={dir}
        data-variant={variant}
        aria-pressed={selected}
        onClick={onClick}
        className={classes}
        style={mergeStyle(base, style)}
      >
        {content}
      </button>
    );
  }
  return (
    <span dir={dir} data-variant={variant} data-selected={selected ? 'true' : undefined} className={classes} style={mergeStyle(base, style)}>
      {content}
    </span>
  );
}
