// REQ-UI-001 — LayerBadge: a layer-tinted Tag with a colour swatch, for CI lists and the layer legend.
import type { ReactNode } from 'react';
import { px, type OmStyle } from '../style.js';
import { layerColor, type LayerName } from '../tokens/index.js';
import { Tag } from './tag.js';

export interface LayerBadgeProps {
  layer: LayerName;
  /** Translated layer name (i18n is the console's job). */
  label: ReactNode;
  swatch?: boolean;
  className?: string;
  style?: OmStyle;
}

const SWATCH_PX = 6;

export function LayerBadge({ layer, label, swatch = true, className, style }: LayerBadgeProps): ReactNode {
  const accent = layerColor(layer);
  const icon = swatch ? (
    <span
      aria-hidden="true"
      data-part="swatch"
      style={{ display: 'inline-block', width: px(SWATCH_PX), height: px(SWATCH_PX), borderRadius: 2, background: accent }}
    />
  ) : undefined;
  return (
    <Tag variant="layer" layer={layer} icon={icon} className={className} style={style}>
      {label}
    </Tag>
  );
}
