// REQ-DCIM-001 REQ-DCIM-003 REQ-DCIM-004 — DCIM bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { DcimResolver } from './dcim.resolver.js';
import { DcimService } from './dcim.service.js';
import { PowerConnectionResolver, PowerFindingResolver, PowerResolver, PowerSourceResolver } from './power.resolver.js';
import { PowerService } from './power.service.js';

@Module({ imports: [CiModule, MetricsModule], providers: [DcimService, DcimResolver, PowerService, PowerResolver, PowerSourceResolver, PowerFindingResolver, PowerConnectionResolver], exports: [DcimService] })
export class DcimModule {}
