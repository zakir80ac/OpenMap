'use client';
// REQ-UI-005 — isometric stack of the twelve layers. Plane colours are the layerColors tokens; geometry is derived
// from the spacing scale so the file carries no numeric literals. Hidden layers render as faint dashed outlines.
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';
import { layerColors, spacing, useDirection } from '@openmap/ui';
import type { ReactNode } from 'react';
import type { LayerVisibility } from '@/hooks/useLayerVisibility';
import { layerKey } from '@/lib/keys';
import { useT } from '@/providers';

/** Isometric unit; a plane is twelve units wide (one per layer) and half as tall. */
const UNIT = spacing['20'];
const HALF_WIDTH = UNIT * spacing['6'];
const WIDTH = HALF_WIDTH + HALF_WIDTH;
const HALF_HEIGHT = spacing['6'] * spacing['10'];
const HEIGHT = HALF_HEIGHT + HALF_HEIGHT;
/** Vertical distance between consecutive planes. */
const STEP = spacing['22'];
const PAD = spacing['12'];
/** Column reserved for the layer labels beside the stack. */
const LABEL_COLUMN = spacing['32'] * spacing['4'];
const LABEL_GAP = spacing['10'];
const LABEL_BASELINE = spacing['4'];

/** Bottom of the stack is the data centre; the top is the SaaS layer, with `unknown` floating above as an outline. */
const PLANES: readonly CiLayer[] = [...CI_LAYERS].reverse();

export interface LayerStackProps {
  visibility: LayerVisibility;
  /** CI counts per layer when loaded; shown after the label. */
  counts?: ReadonlyMap<CiLayer, number>;
  className?: string;
}

function planePoints(x: number, y: number): string {
  return [
    String(x + HALF_WIDTH) + ',' + String(y),
    String(x + WIDTH) + ',' + String(y + HALF_HEIGHT),
    String(x + HALF_WIDTH) + ',' + String(y + HEIGHT),
    String(x) + ',' + String(y + HALF_HEIGHT),
  ].join(' ');
}

export function LayerStack({ visibility, counts, className }: LayerStackProps): ReactNode {
  const t = useT();
  const rtl = useDirection() === 'rtl';
  const planeX = rtl ? PAD + LABEL_COLUMN : PAD;
  const viewWidth = WIDTH + PAD + PAD + LABEL_COLUMN;
  const viewHeight = HEIGHT + STEP * (PLANES.length - 1) + PAD + PAD;
  const labelX = rtl ? planeX - LABEL_GAP : planeX + WIDTH + LABEL_GAP;

  return (
    <svg
      viewBox={'0 0 ' + String(viewWidth) + ' ' + String(viewHeight)}
      role="img"
      aria-label={t('layers.stack')}
      className={className}
      fontFamily="var(--om-font-body)"
      fontSize="11"
    >
      {PLANES.map((layer, index) => {
        const y = PAD + STEP * index;
        const visible = visibility[layer];
        const color = layerColors[layer];
        const count = counts?.get(layer);
        return (
          <g key={layer} data-layer={layer} data-visible={visible ? 'true' : 'false'}>
            <polygon
              points={planePoints(planeX, y)}
              fill={color}
              fillOpacity={visible ? '0.55' : '0.06'}
              stroke={color}
              strokeOpacity={visible ? '0.9' : '0.35'}
              strokeWidth="1"
              strokeLinejoin="round"
              strokeDasharray={visible ? undefined : '4 3'}
            />
            <text
              x={labelX}
              y={y + HALF_HEIGHT + LABEL_BASELINE}
              textAnchor={rtl ? 'end' : 'start'}
              fill={visible ? 'var(--om-text-secondary)' : 'var(--om-text-muted)'}
            >
              {t(layerKey(layer))}
              {count === undefined ? null : (
                <tspan fill="var(--om-text-muted)" fontFamily="var(--om-font-mono)">
                  {' · ' + String(count)}
                </tspan>
              )}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
