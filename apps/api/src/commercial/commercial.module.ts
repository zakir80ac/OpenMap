// REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 (ADR-035) — the commercial register bounded context: vendors,
// contracts and cost centres over their CIs; the asset module supplies the register rows an asset link returns.
import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { CiModule } from '../ci/ci.module.js';
import { CommercialResolver, ContractFieldsResolver } from './commercial.resolver.js';
import { CommercialService } from './commercial.service.js';

@Module({
  imports: [CiModule, AssetsModule],
  providers: [CommercialService, CommercialResolver, ContractFieldsResolver],
})
export class CommercialModule {}
