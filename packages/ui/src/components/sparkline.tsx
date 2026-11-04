// REQ-UI-032 — Sparkline: a small SVG area line for a KPI tile; soft gradient fill, a dot on the last point. Pure SVG from tokens; the console formats nothing here, it only hands over the series.
import type { ReactNode } from 'react';
import { useDirection } from '../direction.js';
import { cx, mergeStyle, px, type OmStyle } from '../style.js';
import { accents, withAlpha, type HexColor } from '../tokens/index.js';

export interface SparklineProps {
  /** Values in time order; the inline end is the newest in both directions. */
  values: readonly number[];
  accent?: HexColor;
  /** Rendered height in px; the width follows the container. */
  height?: number;
  /** Accessible description of the series. */
  label?: string;
  className?: string;
  style?: OmStyle;
}

const VIEW_WIDTH = 100;
const DEFAULT_HEIGHT = 36;
const STROKE_WIDTH = 1.6;
const DOT_RADIUS = 2.2;
const FILL_TOP_ALPHA = 0.35;
const FILL_BOTTOM_ALPHA = 0.02;
/** Padding inside the view box so the stroke and the last dot are never clipped. */
const PAD = 3;

export function sparklinePoints(values: readonly number[], width: number, height: number): Array<[number, number]> {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min === 0 ? 1 : max - min;
  const innerW = width - PAD * 2;
  const innerH = height - PAD * 2;
  const stepX = values.length === 1 ? 0 : innerW / (values.length - 1);
  return values.map((v, i) => [PAD + i * stepX, PAD + innerH - ((v - min) / span) * innerH]);
}

export function Sparkline({ values, accent = accents.cyan, height = DEFAULT_HEIGHT, label, className, style }: SparklineProps): ReactNode {
  const dir = useDirection();
  const points = sparklinePoints(values, VIEW_WIDTH, height);
  const line = points.map(([x, y]) => x.toFixed(2) + ',' + y.toFixed(2)).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const area = first && last ? 'M' + first[0].toFixed(2) + ',' + String(height - PAD) + ' L' + line.replace(/ /g, ' L') + ' L' + last[0].toFixed(2) + ',' + String(height - PAD) + ' Z' : '';
  const gradientId = 'om-spark-' + accent.replace('#', '');
  const base: OmStyle = { display: 'block', width: '100%', height: px(height), overflow: 'visible' };
  return (
    <svg
      data-dir={dir}
      role={label === undefined ? 'presentation' : 'img'}
      aria-label={label}
      viewBox={'0 0 ' + String(VIEW_WIDTH) + ' ' + String(height)}
      preserveAspectRatio="none"
      className={cx('om-sparkline', className)}
      style={mergeStyle(base, style)}
      data-points={values.length}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={withAlpha(accent, FILL_TOP_ALPHA)} />
          <stop offset="1" stopColor={withAlpha(accent, FILL_BOTTOM_ALPHA)} />
        </linearGradient>
      </defs>
      {area !== '' ? <path d={area} fill={'url(#' + gradientId + ')'} transform={dir === 'rtl' ? 'translate(' + String(VIEW_WIDTH) + ' 0) scale(-1 1)' : undefined} /> : null}
      {points.length > 1 ? (
        <polyline
          points={line}
          fill="none"
          stroke={accent}
          strokeWidth={STROKE_WIDTH}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          transform={dir === 'rtl' ? 'translate(' + String(VIEW_WIDTH) + ' 0) scale(-1 1)' : undefined}
        />
      ) : null}
      {last ? <circle cx={dir === 'rtl' ? VIEW_WIDTH - last[0] : last[0]} cy={last[1]} r={DOT_RADIUS} fill={accent} /> : null}
    </svg>
  );
}
