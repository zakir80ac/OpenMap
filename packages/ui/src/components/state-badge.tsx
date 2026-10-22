// REQ-UI-001 — StateBadge: a state-tinted Tag led by a Dot; `live` adds the pulse for streaming health.
import type { ReactNode } from 'react';
import type { OmStyle } from '../style.js';
import type { UiState } from '../tokens/index.js';
import { Dot } from './dot.js';
import { Tag } from './tag.js';

export interface StateBadgeProps {
  state: UiState;
  /** Translated state name (i18n is the console's job). */
  label: ReactNode;
  /** Pulse the dot to show the state is being updated live. */
  live?: boolean;
  className?: string;
  style?: OmStyle;
}

export function StateBadge({ state, label, live = false, className, style }: StateBadgeProps): ReactNode {
  return (
    <Tag variant="state" state={state} icon={<Dot state={state} size={6} pulse={live} />} className={className} style={style}>
      {label}
    </Tag>
  );
}
