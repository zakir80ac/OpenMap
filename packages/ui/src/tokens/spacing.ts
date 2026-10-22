// REQ-UI-001 — spacing scale in px (4,6,8,10,12,14,16,18,20,22,24,28,32). Keys are the px value as a string.

export const spacingSteps = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32] as const;
export type SpacingStep = (typeof spacingSteps)[number];

export const spacing = {
  '4': 4,
  '6': 6,
  '8': 8,
  '10': 10,
  '12': 12,
  '14': 14,
  '16': 16,
  '18': 18,
  '20': 20,
  '22': 22,
  '24': 24,
  '28': 28,
  '32': 32,
} as const satisfies Record<`${SpacingStep}`, SpacingStep>;

export type SpacingName = keyof typeof spacing;

export function spacePx(name: SpacingName): string {
  return String(spacing[name]) + 'px';
}
