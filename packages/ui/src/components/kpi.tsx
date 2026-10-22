// REQ-UI-001 — Kpi: label, large display value and a signed delta coloured by whether the change is good.
import type { ReactNode } from 'react';
import { useDirection } from '../direction.js';
import { cx, mergeStyle, px, type OmStyle } from '../style.js';
import { componentClasses } from '../tailwind-preset.js';
import { accents, displayLetterSpacing, fontSizePx, fontWeight, lineHeight, text, varRef, type HexColor } from '../tokens/index.js';

export type KpiTone = 'positive' | 'negative' | 'neutral';

export interface KpiProps {
  label: ReactNode;
  /** Already formatted for the active locale (number formatting is the console's job). */
  value: ReactNode;
  /** Unit or suffix shown after the value, e.g. a percent sign or "ms". */
  unit?: ReactNode;
  /** Signed change; the sign picks the arrow and, with `lowerIsBetter`, the tone. */
  delta?: number;
  /** Formatted delta text; when omitted the raw number is shown with its sign. */
  deltaLabel?: ReactNode;
  /** Override the computed tone. */
  deltaTone?: KpiTone;
  /** For latency, errors and cost a drop is good. */
  lowerIsBetter?: boolean;
  /** Accent for the value; defaults to primary text. */
  accent?: HexColor;
  className?: string;
  style?: OmStyle;
}

const toneColor: Record<KpiTone, HexColor> = {
  positive: accents.emerald,
  negative: accents.rose,
  neutral: text.secondary,
};

export function kpiTone(delta: number, lowerIsBetter = false): KpiTone {
  if (delta === 0 || Number.isNaN(delta)) return 'neutral';
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return improved ? 'positive' : 'negative';
}

function arrow(delta: number): string {
  if (delta > 0) return '▲';
  if (delta < 0) return '▼';
  return '•';
}

function defaultDeltaLabel(delta: number): string {
  return (delta > 0 ? '+' : '') + String(delta);
}

export function Kpi({ label, value, unit, delta, deltaLabel, deltaTone, lowerIsBetter = false, accent, className, style }: KpiProps): ReactNode {
  const dir = useDirection();
  const tone: KpiTone | undefined = delta === undefined ? undefined : (deltaTone ?? kpiTone(delta, lowerIsBetter));
  const valuePx = fontSizePx['2xl'];
  const base: OmStyle = { '--om-kpi-accent': accent ?? text.primary };
  return (
    <div dir={dir} className={cx('om-kpi', componentClasses.kpi, className)} style={mergeStyle(base, style)}>
      <span
        data-part="label"
        style={{
          fontFamily: varRef('font-body'),
          fontSize: px(fontSizePx.xs),
          fontWeight: fontWeight.medium,
          color: varRef('text-secondary'),
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </span>
      <span data-part="value" style={{ display: 'flex', alignItems: 'baseline', gap: varRef('space-4') }}>
        <span
          style={{
            fontFamily: varRef('font-display'),
            fontSize: px(valuePx),
            fontWeight: fontWeight.bold,
            lineHeight: lineHeight.tight,
            letterSpacing: displayLetterSpacing(valuePx),
            color: 'var(--om-kpi-accent)',
          }}
        >
          {value}
        </span>
        {unit !== undefined ? (
          <span data-part="unit" style={{ fontSize: px(fontSizePx.sm), color: varRef('text-muted') }}>
            {unit}
          </span>
        ) : null}
      </span>
      {delta !== undefined && tone !== undefined ? (
        <span
          data-part="delta"
          data-tone={tone}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: varRef('space-4'),
            fontFamily: varRef('font-mono'),
            fontSize: px(fontSizePx.xs),
            color: toneColor[tone],
          }}
        >
          <span aria-hidden="true">{arrow(delta)}</span>
          <span>{deltaLabel ?? defaultDeltaLabel(delta)}</span>
        </span>
      ) : null}
    </div>
  );
}
