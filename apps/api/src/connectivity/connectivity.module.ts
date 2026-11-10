// REQ-BSM-007 (ADR-025) — sites and connectivity: the Sites screen's read model over the site and link CIs, their probes
// and the readiness findings the BSM engine maintains.
// REQ-IPAM-007 (ADR-069): the network circuit register on the link CIs (saveLinkCircuit) and the LinkCircuit fields.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { OnboardingModule } from '../onboarding/onboarding.module.js';
import { ServicesModule } from '../services/services.module.js';
import { ConnectivityResolver, ReadinessFindingFieldsResolver } from './connectivity.resolver.js';
import { ConnectivityService } from './connectivity.service.js';
import { LinkCircuitsResolver, LinkSharedRiskResolver } from './link-circuits.resolver.js';
import { LinkCircuitsService } from './link-circuits.service.js';

@Module({
  imports: [CiModule, ServicesModule, MetricsModule, OnboardingModule],
  providers: [ConnectivityService, ConnectivityResolver, ReadinessFindingFieldsResolver, LinkCircuitsService, LinkCircuitsResolver, LinkSharedRiskResolver],
  exports: [ConnectivityService],
})
export class ConnectivityModule {}
