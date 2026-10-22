// REQ-UI-001 — shared styling helpers: typed `--om-*` inline variables and a class-name joiner.
import type { CSSProperties } from 'react';

/** React style object that also accepts this package's custom properties (`--om-accent`, ...). */
export type OmStyle = CSSProperties & { [name: `--om-${string}`]: string | number };

/** Join class names, skipping falsy parts. */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

/** Merge a component's base style with the consumer's override (override wins). */
export function mergeStyle(base: OmStyle, override: OmStyle | undefined): OmStyle {
  return override === undefined ? base : { ...base, ...override };
}

export function px(value: number): string {
  return String(value) + 'px';
}

/** Clamp a ratio to 0..1 then express it as a CSS percentage with two decimals. */
export function percent(value: number, max: number): string {
  const ratio = max <= 0 ? 0 : Math.min(Math.max(value / max, 0), 1);
  const HUNDRED = 100;
  return (Math.round(ratio * HUNDRED * HUNDRED) / HUNDRED).toFixed(2) + '%';
}
