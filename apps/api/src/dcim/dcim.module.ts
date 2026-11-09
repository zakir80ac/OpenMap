// REQ-DCIM-001 REQ-DCIM-003 REQ-DCIM-004 REQ-DCIM-005 — DCIM bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { DcimResolver } from './dcim.resolver.js';
import { DcimService } from './dcim.service.js';
import { PowerConnectionResolver, PowerFindingResolver, PowerResolver, PowerSourceResolver } from './power.resolver.js';
import { PowerService } from './power.service.js';
import { DeviceBillResolver, OutletBillResolver, PduMonitorResolver, PowerMonitorResolver } from './power-monitor.resolver.js';
import { PowerMonitorService } from './power-monitor.service.js';

@Module({ imports: [CiModule, MetricsModule], providers: [DcimService, DcimResolver, PowerService, PowerResolver, PowerSourceResolver, PowerFindingResolver, PowerConnectionResolver, PowerMonitorService, PowerMonitorResolver, PduMonitorResolver, OutletBillResolver, DeviceBillResolver], exports: [DcimService] })
export class DcimModule {}
