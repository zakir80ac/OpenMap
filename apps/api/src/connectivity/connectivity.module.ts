// REQ-BSM-007 (ADR-025) — sites and connectivity: the Sites screen's read model over the site and link CIs, their probes
// and the readiness findings the BSM engine maintains.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { ServicesModule } from '../services/services.module.js';
import { ConnectivityResolver, ReadinessFindingFieldsResolver } from './connectivity.resolver.js';
import { ConnectivityService } from './connectivity.service.js';

@Module({
  imports: [CiModule, ServicesModule],
  providers: [ConnectivityService, ConnectivityResolver, ReadinessFindingFieldsResolver],
  exports: [ConnectivityService],
})
export class ConnectivityModule {}
