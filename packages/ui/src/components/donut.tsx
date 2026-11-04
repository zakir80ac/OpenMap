// REQ-UI-032 — Donut: proportional ring of segments with a centre label; each segment glows in its accent. Pure SVG.
import type { ReactNode } from 'react';
import { useDirection } from '../direction.js';
import { cx, mergeStyle, px, type OmStyle } from '../style.js';
import { fontSizePx, fontWeight, varRef, withAlpha, type HexColor } from '../tokens/index.js';

export interface DonutSegment {
  value: number;
  accent: HexColor;
  /** Accessible name of the segment. */
  label: string;
}

export interface DonutProps {
  segments: readonly DonutSegment[];
  /** Text in the centre (already formatted). */
  centre?: ReactNode;
  caption?: ReactNode;
  /** Outer diameter in px. */
  size?: number;
  /** Ring thickness in px. */
  thickness?: number;
  label?: string;
  className?: string;
  style?: OmStyle;
}

const DEFAULT_SIZE = 120;
const DEFAULT_THICKNESS = 12;
const TRACK_ALPHA = 0.08;
const GLOW_ALPHA = 0.5;
const GLOW_BLUR = 3;
/** Gap between segments as a fraction of the full circle. */
const GAP_FRACTION = 0.012;
const FULL_TURN_DEG = 360;
/** Start at twelve o'clock. */
const START_DEG = -90;

export function donutArcs(segments: readonly DonutSegment[]): Array<{ start: number; end: number }> {
  const total = segments.reduce((sum, s) => sum + Math.max(s.value, 0), 0);
  if (total <= 0) return segments.map(() => ({ start: 0, end: 0 }));
  let cursor = 0;
  return segments.map((s) => {
    const share = Math.max(s.value, 0) / total;
    const start = cursor;
    cursor += share;
    return { start, end: cursor };
  });
}

export function Donut({ segments, centre, caption, size = DEFAULT_SIZE, thickness = DEFAULT_THICKNESS, label, className, style }: DonutProps): ReactNode {
  const dir = useDirection();
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const arcs = donutArcs(segments);
  const centreXY = size / 2;
  const base: OmStyle = { position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: varRef('space-6') };
  return (
    <div dir={dir} className={cx('om-donut', className)} style={mergeStyle(base, style)}>
      <svg role={label === undefined ? 'presentation' : 'img'} aria-label={label} width={size} height={size} viewBox={'0 0 ' + String(size) + ' ' + String(size)} style={{ display: 'block', overflow: 'visible' }}>
        <circle cx={centreXY} cy={centreXY} r={radius} fill="none" stroke={withAlpha('#FFFFFF', TRACK_ALPHA)} strokeWidth={thickness} />
        {segments.map((s, i) => {
          const arc = arcs[i];
          if (arc === undefined || arc.end - arc.start <= 0) return null;
          const length = Math.max(arc.end - arc.start - GAP_FRACTION, 0) * circumference;
          const offset = arc.start * circumference;
          return (
            <circle
              key={s.label}
              cx={centreXY}
              cy={centreXY}
              r={radius}
              fill="none"
              stroke={s.accent}
              strokeWidth={thickness}
              strokeLinecap="butt"
              strokeDasharray={length.toFixed(2) + ' ' + (circumference - length).toFixed(2)}
              strokeDashoffset={(-offset).toFixed(2)}
              transform={'rotate(' + String(START_DEG) + ' ' + String(centreXY) + ' ' + String(centreXY) + ')'}
              style={{ filter: 'drop-shadow(0 0 ' + String(GLOW_BLUR) + 'px ' + withAlpha(s.accent, GLOW_ALPHA) + ')' }}
              data-segment={s.label}
            >
              <title>{s.label}</title>
            </circle>
          );
        })}
      </svg>
      {centre !== undefined ? (
        <span
          data-part="centre"
          style={{
            position: 'absolute',
            top: px(centreXY),
            insetInlineStart: '50%',
            transform: 'translate(' + (dir === 'rtl' ? '50%' : '-50%') + ', -50%)',
            fontFamily: varRef('font-display'),
            fontSize: px(fontSizePx.xl),
            fontWeight: fontWeight.bold,
            color: varRef('text-primary'),
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          {centre}
        </span>
      ) : null}
      {caption !== undefined ? (
        <span data-part="caption" style={{ fontSize: px(fontSizePx.xs), color: varRef('text-secondary') }}>
          {caption}
        </span>
      ) : null}
    </div>
  );
}

/** Degrees a share of the ring covers; exported for tests. */
export function shareDegrees(share: number): number {
  return share * FULL_TURN_DEG;
}
