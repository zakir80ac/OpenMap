// REQ-BSM-003 — impact modelling bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { ServicesModule } from '../services/services.module.js';
import { IMPACT_REPOSITORY, PrismaImpactRepository } from './impact.repository.js';
import { ImpactResolver, ImpactScenarioFieldsResolver, ImpactSimulationFieldsResolver } from './impact.resolver.js';
import { ImpactService } from './impact.service.js';

@Module({
  imports: [CiModule, ServicesModule],
  providers: [{ provide: IMPACT_REPOSITORY, useClass: PrismaImpactRepository }, ImpactService, ImpactResolver, ImpactScenarioFieldsResolver, ImpactSimulationFieldsResolver],
})
export class ImpactModule {}
