// REQ-UI-001 — motion tokens: durations and easings shared by hover, reveal and progress animations.

export const duration = {
  /** hover / press feedback */
  fast: '120ms',
  /** state changes: colour, shadow, opacity */
  base: '180ms',
  /** panels sliding, bars filling */
  slow: '260ms',
  /** time-travel scrubbing and large layout shifts */
  slower: '400ms',
} as const;

export type DurationName = keyof typeof duration;

export const easing = {
  /** default for most property transitions */
  standard: 'cubic-bezier(.2,.8,.2,1)',
  /** elements entering the screen */
  decelerate: 'cubic-bezier(0,0,.2,1)',
  /** elements leaving the screen */
  accelerate: 'cubic-bezier(.4,0,1,1)',
  /** pulsing dots */
  inOut: 'cubic-bezier(.45,0,.55,1)',
} as const;

export type EasingName = keyof typeof easing;

/** Period of the live-state pulse used by Dot and live Pills. */
export const pulsePeriod = '2.4s' as const;

export const motion = { duration, easing, pulsePeriod } as const;

/** Compose a `transition` value for the given properties with base timing. */
export function transition(properties: readonly string[], name: DurationName = 'base', ease: EasingName = 'standard'): string {
  return properties.map((p) => p + ' ' + duration[name] + ' ' + easing[ease]).join(', ');
}
