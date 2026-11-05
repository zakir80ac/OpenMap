// REQ-BSM-002 REQ-BSM-006 REQ-BSM-008 — business service management bounded context (ADR-024).
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { DbModule } from '../db/db.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { AvailabilityService } from './availability.service.js';
import { BsmFactsService } from './bsm-facts.service.js';
import { PrismaSlaRepository, SLA_REPOSITORY } from './sla.repository.js';
import { BSM_REPOSITORY, PrismaBsmRepository } from './services.repository.js';
import {
  AvailabilityPeriodFieldsResolver,
  IncidentFieldsResolver,
  IncidentLinkFieldsResolver,
  RcaFieldsResolver,
  ServiceHealthFieldsResolver,
  ServicesResolver,
  SlaFieldsResolver,
} from './services.resolver.js';
import { ServicesService } from './services.service.js';

@Module({
  imports: [CiModule, IntegrationsModule, DbModule, TenantModule],
  providers: [
    { provide: BSM_REPOSITORY, useClass: PrismaBsmRepository },
    { provide: SLA_REPOSITORY, useClass: PrismaSlaRepository },
    AvailabilityService,
    BsmFactsService,
    ServicesService,
    ServicesResolver,
    ServiceHealthFieldsResolver,
    AvailabilityPeriodFieldsResolver,
    SlaFieldsResolver,
    IncidentFieldsResolver,
    RcaFieldsResolver,
    IncidentLinkFieldsResolver,
  ],
  exports: [BSM_REPOSITORY, SLA_REPOSITORY, BsmFactsService, ServicesService, AvailabilityService],
})
export class ServicesModule {}
