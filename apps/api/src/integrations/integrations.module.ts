// REQ-INT-005 — integrations bounded context.
import { Module } from '@nestjs/common';
import { INTEGRATIONS_REPOSITORY, PrismaIntegrationsRepository } from './integrations.repository.js';
import { IntegrationsResolver } from './integrations.resolver.js';
import { IntegrationsService } from './integrations.service.js';
import { SecretsService } from './secrets.service.js';

@Module({
  providers: [{ provide: INTEGRATIONS_REPOSITORY, useClass: PrismaIntegrationsRepository }, SecretsService, IntegrationsService, IntegrationsResolver],
  exports: [INTEGRATIONS_REPOSITORY, SecretsService, IntegrationsService],
})
export class IntegrationsModule {}
