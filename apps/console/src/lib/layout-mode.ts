// REQ-UI-007 REQ-DEP-005 — the dependency map's layout modes. Kept free of client-only imports so the server route
// can parse the query string with it; the layout algorithms live in graph-layout.ts.
export const LAYOUT_MODES = ['lane', 'force'] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export function isLayoutMode(value: string | undefined): value is LayoutMode {
  return value !== undefined && (LAYOUT_MODES as readonly string[]).includes(value);
}
