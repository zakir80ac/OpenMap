// REQ-DCIM-001 (ADR-056) — structured cabling: patch panels, cables, cross-connects and carrier circuits.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { CableEndpointResolver, CableHopResolver, CablingResolver, PatchPanelResolver } from './cabling.resolver.js';
import { CablingService } from './cabling.service.js';

@Module({
  imports: [CiModule, MetricsModule],
  providers: [CablingService, CablingResolver, CableEndpointResolver, PatchPanelResolver, CableHopResolver],
})
export class CablingModule {}
