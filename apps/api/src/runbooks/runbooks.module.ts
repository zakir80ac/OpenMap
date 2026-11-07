// REQ-BSM-005 (ADR-048) — runbooks bounded context: the tenant's catalogue, attachments to scenarios and incidents,
// and step runs that trigger SOAR or automation integrations.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { ImpactModule } from '../impact/impact.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ServicesModule } from '../services/services.module.js';
import { PrismaRunbooksRepository, RUNBOOKS_REPOSITORY } from './runbooks.repository.js';
import {
  IncidentRunbookFieldsResolver,
  RunbookAutomationFieldsResolver,
  RunbookFieldsResolver,
  RunbooksResolver,
  RunbookStepRunFieldsResolver,
  ScenarioRunbookFieldsResolver,
} from './runbooks.resolver.js';
import { RunbooksService } from './runbooks.service.js';

@Module({
  imports: [CiModule, ImpactModule, IntegrationsModule, MetricsModule, ServicesModule],
  providers: [
    { provide: RUNBOOKS_REPOSITORY, useClass: PrismaRunbooksRepository },
    RunbooksService,
    RunbooksResolver,
    RunbookFieldsResolver,
    RunbookAutomationFieldsResolver,
    RunbookStepRunFieldsResolver,
    ScenarioRunbookFieldsResolver,
    IncidentRunbookFieldsResolver,
  ],
})
export class RunbooksModule {}
