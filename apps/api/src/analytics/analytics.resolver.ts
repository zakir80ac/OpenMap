// REQ-UI-017 — `analyticsEmbed`: the tenant-scoped Superset guest token and dashboard id for the Analytics screen.
import { Query, Resolver } from '@nestjs/graphql';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { AnalyticsService, type AnalyticsEmbedView } from './analytics.service.js';

@Resolver()
export class AnalyticsResolver {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('analyticsEmbed')
  @Roles(ROLES.analyst)
  analyticsEmbed(): Promise<AnalyticsEmbedView> {
    return this.analytics.embed(this.tenant.tenantId);
  }
}
