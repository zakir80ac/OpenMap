// REQ-UI-001 — SectionTitle: display-font heading with optional eyebrow, description and an inline-end action slot.
import type { ReactNode } from 'react';
import { useDirection } from '../direction.js';
import { cx, mergeStyle, px, type OmStyle } from '../style.js';
import { componentClasses } from '../tailwind-preset.js';
import { displayLetterSpacing, fontSizePx, fontWeight, lineHeight, varRef } from '../tokens/index.js';

export const SECTION_TITLE_SIZES = ['sm', 'md', 'lg'] as const;
export type SectionTitleSize = (typeof SECTION_TITLE_SIZES)[number];

export interface SectionTitleProps {
  children: ReactNode;
  /** Small secondary line above the title. */
  eyebrow?: ReactNode;
  /** Secondary line below the title. */
  description?: ReactNode;
  /** Slot aligned to the inline end (buttons, pills). */
  action?: ReactNode;
  size?: SectionTitleSize;
  as?: 'h1' | 'h2' | 'h3' | 'h4';
  className?: string;
  style?: OmStyle;
}

/** Thickness of the glowing line before an eyebrow. */
const EYEBROW_LINE_PX = 1;

const sizePx: Record<SectionTitleSize, number> = {
  sm: fontSizePx.md,
  md: fontSizePx.lg,
  lg: fontSizePx.xl,
};

export function SectionTitle({ children, eyebrow, description, action, size = 'md', as: Heading = 'h2', className, style }: SectionTitleProps): ReactNode {
  const dir = useDirection();
  const titlePx = sizePx[size];
  const base: OmStyle = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: varRef('space-12'),
    textAlign: 'start',
  };
  return (
    <div dir={dir} className={cx('om-section-title', className)} style={mergeStyle(base, style)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: varRef('space-4'), minWidth: 0 }}>
        {eyebrow !== undefined ? (
          <span
            data-part="eyebrow"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: varRef('space-8'),
              fontFamily: varRef('font-mono'),
              fontSize: px(fontSizePx.xs),
              fontWeight: fontWeight.medium,
              color: varRef('accent-cyan'),
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
            }}
          >
            <span
              aria-hidden="true"
              data-part="eyebrow-line"
              style={{
                display: 'inline-block',
                width: varRef('space-16'),
                height: px(EYEBROW_LINE_PX),
                background: 'linear-gradient(' + varRef('dir-flow-angle') + ', ' + varRef('accent-cyan') + ', transparent)',
              }}
            />
            {eyebrow}
          </span>
        ) : null}
        <Heading
          className={componentClasses.sectionTitle}
          style={{
            margin: 0,
            fontFamily: varRef('font-display'),
            fontSize: px(titlePx),
            fontWeight: fontWeight.semibold,
            lineHeight: lineHeight.snug,
            letterSpacing: displayLetterSpacing(titlePx),
            color: varRef('text-primary'),
          }}
        >
          {children}
        </Heading>
        {description !== undefined ? (
          <span data-part="description" style={{ fontSize: px(fontSizePx.sm), color: varRef('text-secondary'), lineHeight: lineHeight.normal }}>
            {description}
          </span>
        ) : null}
      </div>
      {action !== undefined ? (
        <div data-part="action" style={{ marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: varRef('space-8') }}>
          {action}
        </div>
      ) : null}
    </div>
  );
}
