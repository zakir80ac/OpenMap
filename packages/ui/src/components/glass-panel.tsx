// REQ-UI-001 — GlassPanel: surface2 panel with glass border, inner highlight, backdrop blur and an optional accent edge.
import type { ReactNode } from 'react';
import { useDirection } from '../direction.js';
import { cx, mergeStyle, type OmStyle } from '../style.js';
import { componentClasses } from '../tailwind-preset.js';
import { accents, varRef, withAlpha, type HexColor, type SpacingName } from '../tokens/index.js';

export interface GlassPanelProps {
  children: ReactNode;
  className?: string;
  style?: OmStyle;
  padding?: SpacingName;
  /** Accent for the 1px top edge; omit for no edge. */
  accent?: HexColor;
  as?: 'div' | 'section' | 'aside' | 'nav';
}

const EDGE_ALPHA = 0.55;

export function GlassPanel({ children, className, style, padding = '16', accent, as: Tag = 'div' }: GlassPanelProps): ReactNode {
  const dir = useDirection();
  const edge = accent ?? accents.cyan;
  const base: OmStyle = {
    position: 'relative',
    padding: varRef('space-' + padding),
    color: varRef('text-primary'),
    '--om-panel-accent': withAlpha(edge, EDGE_ALPHA),
  };
  return (
    <Tag dir={dir} className={cx('om-glass-panel', componentClasses.glassPanel, className)} style={mergeStyle(base, style)}>
      {accent !== undefined ? (
        <span
          aria-hidden="true"
          data-part="accent-edge"
          style={{
            position: 'absolute',
            insetBlockStart: 0,
            insetInline: varRef('space-16'),
            height: 1,
            background: 'linear-gradient(' + varRef('dir-flow-angle') + ', transparent, var(--om-panel-accent), transparent)',
            pointerEvents: 'none',
          }}
        />
      ) : null}
      {children}
    </Tag>
  );
}
