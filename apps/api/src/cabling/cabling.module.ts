// REQ-DCIM-001 REQ-DCIM-008 (ADR-056, ADR-062) — structured cabling: patch panels, cables, cross-connects, carrier
// circuits, and the verification of recorded cables against observed adjacencies.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import {
  CableEndpointResolver,
  CableHopResolver,
  CablingResolver,
  PatchPanelResolver,
} from './cabling.resolver.js';
import { CablingService } from './cabling.service.js';
import { CablingVerificationResolver, ObservedPortResolver } from './cabling-verify.resolver.js';
import { CablingVerificationService } from './cabling-verify.service.js';

@Module({
  imports: [CiModule, MetricsModule],
  providers: [
    CablingService,
    CablingResolver,
    CableEndpointResolver,
    PatchPanelResolver,
    CableHopResolver,
    CablingVerificationService,
    CablingVerificationResolver,
    ObservedPortResolver,
  ],
})
export class CablingModule {}
