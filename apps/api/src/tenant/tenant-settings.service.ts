// REQ-CORE-012 — tenant settings over the tenant_settings table; the TenantSettingsRepository the
// config package declares. Missing rows resolve to the documented defaults.
import { Injectable } from '@nestjs/common';
import { parseTenantSettings, TENANT_SETTINGS_DEFAULTS, type TenantSettings, type TenantSettingsRepository } from '@openmap/config';
import { PrismaService } from '../db/prisma.service.js';

@Injectable()
export class TenantSettingsService implements TenantSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: string): Promise<TenantSettings> {
    const row = await this.prisma.client.tenantSettings.findUnique({ where: { tenantId } });
    if (!row) return { ...TENANT_SETTINGS_DEFAULTS };
    return parseTenantSettings({
      locale: row.locale,
      timeZone: row.timeZone,
      discoveryIntervalMinutes: row.discoveryIntervalMinutes,
      historyRetentionDays: row.historyRetentionDays,
      staleAfterDays: row.staleAfterDays,
      auditRetentionDays: row.auditRetentionDays,
      assistantEnabled: row.assistantEnabled,
      outboundIntegrationsEnabled: row.outboundIntegrationsEnabled,
    });
  }

  async update(tenantId: string, patch: Partial<TenantSettings>): Promise<TenantSettings> {
    const next = parseTenantSettings({ ...(await this.get(tenantId)), ...patch });
    await this.prisma.client.tenantSettings.upsert({ where: { tenantId }, create: { tenantId, ...next }, update: next });
    return next;
  }
}
