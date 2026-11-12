// REQ-UI-001 — Card: surface1 container with glass border, inner highlight and the deep card shadow.
import type { AriaAttributes, ReactNode } from 'react';
import { useDirection } from '../direction.js';
import { cx, mergeStyle, type OmStyle } from '../style.js';
import { componentClasses } from '../tailwind-preset.js';
import { varRef, type SpacingName } from '../tokens/index.js';

/**
 * ARIA attributes pass through to the element (REQ-UI-037: hyphenated props escape TypeScript's excess-property check,
 * so a label given to a Card was silently dropped before), as does a test id.
 */
export interface CardProps extends AriaAttributes {
  'data-testid'?: string;
  children: ReactNode;
  className?: string;
  style?: OmStyle;
  /** Inner padding step from the spacing scale. */
  padding?: SpacingName;
  /** Semantic element; defaults to a plain div. */
  as?: 'div' | 'section' | 'article' | 'aside';
}

export function Card({ children, className, style, padding = '20', as: Tag = 'div', ...rest }: CardProps): ReactNode {
  const dir = useDirection();
  const base: OmStyle = {
    padding: varRef('space-' + padding),
    color: varRef('text-primary'),
  };
  return (
    <Tag {...rest} dir={dir} className={cx('om-card', componentClasses.card, className)} style={mergeStyle(base, style)}>
      {children}
    </Tag>
  );
}
