// REQ-UI-030 — dashboards bounded context (ADR-020): persistence, use cases, the estate aggregate and the resolver.
import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { DbModule } from '../db/db.module.js';
import { DcimModule } from '../dcim/dcim.module.js';
import { DiscoveryModule } from '../discovery/discovery.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { IpamModule } from '../ipam/ipam.module.js';
import { ServicesModule } from '../services/services.module.js';
import { SoftwareModule } from '../software/software.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { DASHBOARDS_REPOSITORY, PrismaDashboardsRepository } from './dashboards.repository.js';
import { DashboardsResolver } from './dashboards.resolver.js';
import { DashboardsService } from './dashboards.service.js';
import { EstateStatsService } from './estate-stats.service.js';

@Module({
  imports: [DbModule, TenantModule, AssetsModule, SoftwareModule, DcimModule, IpamModule, DiscoveryModule, IntegrationsModule, ServicesModule],
  providers: [{ provide: DASHBOARDS_REPOSITORY, useClass: PrismaDashboardsRepository }, DashboardsService, EstateStatsService, DashboardsResolver],
  exports: [DashboardsService, EstateStatsService],
})
export class DashboardsModule {}
