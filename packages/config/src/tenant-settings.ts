// REQ-CORE-003 — tenant-scoped settings schema. Values live in the database (tenant_settings
// table in packages/db); they are a separate, per-tenant layer above the process environment.
import { z } from 'zod';
import { LOCALES } from '@openmap/constants';

export const tenantSettingsSchema = z.object({
  /** UI locale for this tenant; users may override per profile. */
  locale: z.enum(LOCALES),
  /** IANA time zone for display and scheduling. */
  timeZone: z.string().min(1),
  /** Discovery sweep cadence in minutes. */
  discoveryIntervalMinutes: z.number().int().positive(),
  /** Days of time-travel history retained in ClickHouse before compaction. */
  historyRetentionDays: z.number().int().positive(),
  /** Days after which an unseen CI is marked stale. */
  staleAfterDays: z.number().int().positive(),
  /** Whether the AI assistant is enabled for this tenant (requires FEATURE_ASSISTANT). */
  assistantEnabled: z.boolean(),
  /** Whether tenant-enabled outbound integrations may make network calls. */
  outboundIntegrationsEnabled: z.boolean(),
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

/** Defaults applied when a tenant is created. */
export const TENANT_SETTINGS_DEFAULTS: TenantSettings = {
  locale: 'en',
  timeZone: 'UTC',
  discoveryIntervalMinutes: 60,
  historyRetentionDays: 365,
  staleAfterDays: 7,
  assistantEnabled: true,
  outboundIntegrationsEnabled: false,
};

/** Repository interface implemented in apps/api over Postgres. */
export interface TenantSettingsRepository {
  get(tenantId: string): Promise<TenantSettings>;
  update(tenantId: string, patch: Partial<TenantSettings>): Promise<TenantSettings>;
}

export function parseTenantSettings(input: Record<string, unknown>): TenantSettings {
  return tenantSettingsSchema.parse({ ...TENANT_SETTINGS_DEFAULTS, ...input });
}
