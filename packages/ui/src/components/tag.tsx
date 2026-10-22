// REQ-UI-001 — Tag: compact label tinted by a health state or a CI layer (or neutral).
import type { ReactNode } from 'react';
import { useDirection } from '../direction.js';
import { cx, mergeStyle, type OmStyle } from '../style.js';
import { componentClasses } from '../tailwind-preset.js';
import { layerColor, stateColor, text, varRef, withAlpha, type HexColor, type LayerName, type UiState, readableAccent } from '../tokens/index.js';

export type TagVariant = 'neutral' | 'state' | 'layer';

interface TagBaseProps {
  children: ReactNode;
  /** Leading slot, e.g. a Dot. */
  icon?: ReactNode;
  className?: string | undefined;
  style?: OmStyle | undefined;
}

export type TagProps =
  | (TagBaseProps & { variant?: 'neutral'; state?: undefined; layer?: undefined })
  | (TagBaseProps & { variant: 'state'; state: UiState; layer?: undefined })
  | (TagBaseProps & { variant: 'layer'; layer: LayerName; state?: undefined });

const TINT_ALPHA = 0.12;
const BORDER_ALPHA = 0.3;

export function tagAccent(props: TagProps): HexColor {
  if (props.variant === 'state') return stateColor(props.state);
  if (props.variant === 'layer') return layerColor(props.layer);
  return text.secondary;
}

export function Tag(props: TagProps): ReactNode {
  const { children, icon, className, style } = props;
  const variant: TagVariant = props.variant ?? 'neutral';
  const dir = useDirection();
  const accent = tagAccent(props);
  const base: OmStyle = {
    '--om-tag-accent': accent,
    paddingInline: varRef('space-6'),
    paddingBlock: varRef('space-4'),
    color: readableAccent(accent),
    borderColor: withAlpha(accent, BORDER_ALPHA),
    background: withAlpha(accent, TINT_ALPHA),
  };
  return (
    <span
      dir={dir}
      data-variant={variant}
      data-state={props.variant === 'state' ? props.state : undefined}
      data-layer={props.variant === 'layer' ? props.layer : undefined}
      className={cx('om-tag', componentClasses.tag, className)}
      style={mergeStyle(base, style)}
    >
      {icon !== undefined ? <span data-part="icon">{icon}</span> : null}
      <span data-part="label">{children}</span>
    </span>
  );
}
