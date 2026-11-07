// REQ-BSM-003 REQ-BSM-004 — impact modelling bounded context: what-if scenarios and their simulations, and the
// prediction accuracy measured against resolved incidents (ADR-047).
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ServicesModule } from '../services/services.module.js';
import { IMPACT_VALIDATION_REPOSITORY, PrismaImpactValidationRepository } from './impact-validation.repository.js';
import { ImpactValidationFieldsResolver, ImpactValidationResolver, RelationshipSuggestionFieldsResolver } from './impact-validation.resolver.js';
import { ImpactValidationService } from './impact-validation.service.js';
import { IMPACT_REPOSITORY, PrismaImpactRepository } from './impact.repository.js';
import { ImpactResolver, ImpactScenarioFieldsResolver, ImpactSimulationFieldsResolver } from './impact.resolver.js';
import { ImpactService } from './impact.service.js';

@Module({
  imports: [CiModule, ServicesModule, MetricsModule],
  providers: [
    { provide: IMPACT_REPOSITORY, useClass: PrismaImpactRepository },
    { provide: IMPACT_VALIDATION_REPOSITORY, useClass: PrismaImpactValidationRepository },
    ImpactService,
    ImpactValidationService,
    ImpactResolver,
    ImpactScenarioFieldsResolver,
    ImpactSimulationFieldsResolver,
    ImpactValidationResolver,
    ImpactValidationFieldsResolver,
    RelationshipSuggestionFieldsResolver,
  ],
})
export class ImpactModule {}
