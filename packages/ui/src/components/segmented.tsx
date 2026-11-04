// REQ-UI-032 — Segmented: a row of exclusive options (7d · 30d · 90d, grid sizes, personas) rendered as a radiogroup;
// the selected segment is a lit cyan pill, the others glass.
import type { ReactNode } from 'react';
import { useDirection } from '../direction.js';
import { cx, mergeStyle, px, type OmStyle } from '../style.js';
import { accents, fontSizePx, fontWeight, glow, transition, varRef, withAlpha } from '../tokens/index.js';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
  style?: OmStyle;
}

const SELECTED_BG_ALPHA = 0.18;
const SELECTED_BORDER_ALPHA = 0.5;
const PAD_INLINE = { sm: 'space-10', md: 'space-12' } as const;
const PAD_BLOCK = { sm: 'space-4', md: 'space-6' } as const;

export function Segmented<T extends string>({ options, value, onChange, label, size = 'sm', className, style }: SegmentedProps<T>): ReactNode {
  const dir = useDirection();
  const base: OmStyle = {
    display: 'inline-flex',
    gap: varRef('space-4'),
    padding: varRef('space-4'),
    borderRadius: varRef('radius-pill'),
    border: '1px solid ' + varRef('border-glass'),
    background: varRef('surface2'),
  };
  return (
    <div dir={dir} role="radiogroup" aria-label={label} className={cx('om-segmented', className)} style={mergeStyle(base, style)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              onChange(option.value);
            }}
            data-selected={selected}
            style={{
              borderRadius: varRef('radius-pill'),
              border: '1px solid ' + (selected ? withAlpha(accents.cyan, SELECTED_BORDER_ALPHA) : 'transparent'),
              background: selected ? withAlpha(accents.cyan, SELECTED_BG_ALPHA) : 'transparent',
              color: selected ? accents.cyan : varRef('text-secondary'),
              boxShadow: selected ? glow('bar', accents.cyan) : undefined,
              fontFamily: varRef('font-body'),
              fontSize: px(fontSizePx.xs),
              fontWeight: fontWeight.medium,
              lineHeight: 1,
              paddingInline: varRef(PAD_INLINE[size]),
              paddingBlock: varRef(PAD_BLOCK[size]),
              cursor: 'pointer',
              transition: transition(['background-color', 'color', 'box-shadow'], 'fast'),
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
