// REQ-CMDB-033 REQ-CMDB-036 (ADR-032) — imports and exports: spreadsheets and other CMDBs' exports in through the
// reconciler as the import source, CIs out as CSV, XLSX or JSON.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { DbModule } from '../db/db.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { ExportController } from './export.controller.js';
import { ImportsResolver } from './imports.resolver.js';
import { ImportsService } from './imports.service.js';

@Module({
  imports: [CiModule, DbModule, MetricsModule, TenantModule],
  controllers: [ExportController],
  providers: [ImportsService, ImportsResolver],
})
export class ImportsModule {}
