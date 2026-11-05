// REQ-UI-030 — dashboard contract (ADR-020): a dashboard is a named, owned, optionally shared list of widgets; a
// persona template seeds that list and the owner customises it. The widget catalogue is the contract: the console
// renders a kind, the API validates it, and a persona's template is the same list on both sides.
import { DASHBOARD } from '@openmap/constants';
import { z } from 'zod';

export const DASHBOARD_PERSONAS = ['admin', 'cto_cio', 'ciso', 'finance', 'custom'] as const;
export const dashboardPersonaSchema = z.enum(DASHBOARD_PERSONAS);
export type DashboardPersona = z.infer<typeof dashboardPersonaSchema>;

/** Widget kinds, grouped by the screen whose data they show. Every kind renders from live queries. */
export const WIDGET_KINDS = [
  'estate.cis',
  'estate.layers',
  'estate.trend',
  'services.health',
  'services.sla',
  /** REQ-UI-036: overall availability of the business services this month against last month. */
  'services.uptime',
  'incidents.open',
  'impact.recent',
  'discovery.sweep',
  'discovery.nodes',
  'discovery.jobs',
  'security.vulnerabilities',
  'security.exposure',
  'software.end_of_support',
  'software.licences',
  'assets.stages',
  'assets.warranty',
  'finance.licence_cost',
  'finance.asset_value',
  'finance.plans',
  'dcim.power',
  'ipam.utilisation',
  'integrations.health',
  'audit.recent',
  'platform.settings',
] as const;
export const widgetKindSchema = z.enum(WIDGET_KINDS);
export type WidgetKind = z.infer<typeof widgetKindSchema>;

/** Widget widths in grid columns: s = 1, m = 2, l = 3, xl = the full row (DASHBOARD.columns). */
export const WIDGET_SIZES = ['s', 'm', 'l', 'xl'] as const;
export const widgetSizeSchema = z.enum(WIDGET_SIZES);
export type WidgetSize = z.infer<typeof widgetSizeSchema>;
export const WIDGET_SIZE_COLUMNS: Record<WidgetSize, number> = { s: 1, m: 2, l: 3, xl: DASHBOARD.columns };

export const dashboardWidgetInputSchema = z.object({
  kind: widgetKindSchema,
  size: widgetSizeSchema,
  /** Per-kind settings (a horizon in days, a CVSS floor); validated by the widget that reads them. */
  options: z.record(z.string(), z.unknown()).default({}),
});
export type DashboardWidgetInput = z.infer<typeof dashboardWidgetInputSchema>;

export const dashboardWidgetSchema = dashboardWidgetInputSchema.extend({
  /** Stable per-dashboard id so reordering and editing keep React keys and audit details meaningful. */
  id: z.string().min(1),
});
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;

export const dashboardInputSchema = z.object({
  name: z.string().trim().min(1).max(DASHBOARD.nameMaxChars),
  persona: dashboardPersonaSchema,
  shared: z.boolean().default(false),
  widgets: z.array(dashboardWidgetInputSchema).min(1).max(DASHBOARD.maxWidgets),
});
export type DashboardInput = z.infer<typeof dashboardInputSchema>;

export const dashboardSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  name: z.string().min(1).max(DASHBOARD.nameMaxChars),
  persona: dashboardPersonaSchema,
  /** Username of the owner; only the owner edits or deletes, everyone in the tenant reads a shared one. */
  owner: z.string().min(1),
  shared: z.boolean(),
  /** The owner's landing dashboard; at most one per owner. */
  isDefault: z.boolean(),
  widgets: z.array(dashboardWidgetSchema).max(DASHBOARD.maxWidgets),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

type TemplatePersona = Exclude<DashboardPersona, 'custom'>;

/**
 * Persona templates: what each role opens the console for, in the order they read it. Sizes add up to full rows on
 * a four-column grid. The wizard pre-ticks these; the owner can add any other kind.
 */
export const DASHBOARD_TEMPLATES: Record<
  TemplatePersona,
  ReadonlyArray<{ kind: WidgetKind; size: WidgetSize }>
> = {
  admin: [
    { kind: 'estate.cis', size: 's' },
    { kind: 'services.uptime', size: 's' },
    { kind: 'discovery.sweep', size: 's' },
    { kind: 'discovery.nodes', size: 's' },
    { kind: 'estate.trend', size: 'l' },
    { kind: 'integrations.health', size: 's' },
    { kind: 'estate.layers', size: 'm' },
    { kind: 'discovery.jobs', size: 'm' },
    { kind: 'platform.settings', size: 's' },
    { kind: 'audit.recent', size: 'l' },
  ],
  cto_cio: [
    { kind: 'services.health', size: 's' },
    { kind: 'services.uptime', size: 's' },
    { kind: 'incidents.open', size: 's' },
    { kind: 'estate.cis', size: 's' },
    { kind: 'services.sla', size: 'm' },
    { kind: 'estate.trend', size: 'm' },
    { kind: 'estate.layers', size: 'm' },
    { kind: 'impact.recent', size: 'm' },
    { kind: 'software.end_of_support', size: 's' },
    { kind: 'finance.plans', size: 'l' },
  ],
  ciso: [
    { kind: 'security.vulnerabilities', size: 'm' },
    { kind: 'security.exposure', size: 's' },
    { kind: 'software.end_of_support', size: 's' },
    { kind: 'services.health', size: 's' },
    { kind: 'integrations.health', size: 's' },
    { kind: 'assets.warranty', size: 'm' },
    { kind: 'audit.recent', size: 'xl' },
  ],
  finance: [
    { kind: 'finance.asset_value', size: 's' },
    { kind: 'finance.licence_cost', size: 's' },
    { kind: 'software.licences', size: 's' },
    { kind: 'dcim.power', size: 's' },
    { kind: 'assets.stages', size: 'm' },
    { kind: 'finance.plans', size: 'm' },
    { kind: 'assets.warranty', size: 'xl' },
  ],
};

/** The widget list a persona starts from; `custom` starts from the estate's basic tiles. */
export function templateWidgets(persona: DashboardPersona): DashboardWidgetInput[] {
  const list =
    persona === 'custom'
      ? DASHBOARD_TEMPLATES.cto_cio.slice(0, DASHBOARD.columns)
      : DASHBOARD_TEMPLATES[persona];
  return list.map((w) => ({ kind: w.kind, size: w.size, options: {} }));
}
