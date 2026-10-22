// REQ-UI-001 — corner radii in px: tag 7, controls 8–11, panels 12–14, cards 18, pills 999.

export const radii = {
  tag: 7,
  control: 8,
  controlMd: 10,
  controlLg: 11,
  panel: 12,
  panelLg: 14,
  card: 18,
  pill: 999,
} as const;

export type RadiusName = keyof typeof radii;

export function radiusPx(name: RadiusName): string {
  return String(radii[name]) + 'px';
}
