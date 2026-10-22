// REQ-BSM-002 — business service management bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { BsmFactsService } from './bsm-facts.service.js';
import { BSM_REPOSITORY, PrismaBsmRepository } from './services.repository.js';
import { IncidentFieldsResolver, IncidentLinkFieldsResolver, ServicesResolver } from './services.resolver.js';
import { ServicesService } from './services.service.js';

@Module({
  imports: [CiModule, IntegrationsModule],
  providers: [{ provide: BSM_REPOSITORY, useClass: PrismaBsmRepository }, BsmFactsService, ServicesService, ServicesResolver, IncidentFieldsResolver, IncidentLinkFieldsResolver],
  exports: [BSM_REPOSITORY, BsmFactsService, ServicesService],
})
export class ServicesModule {}
