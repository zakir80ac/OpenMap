// REQ-INT-016 (ADR-074) — identity federation bounded context: identity sources applied to Keycloak.
import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { IdentitySourcesResolver } from './identity-sources.resolver.js';
import { IdentitySourcesService } from './identity-sources.service.js';
import { KeycloakAdminClient } from './keycloak-admin.client.js';

@Module({
  imports: [MetricsModule, IntegrationsModule],
  providers: [KeycloakAdminClient, IdentitySourcesService, IdentitySourcesResolver],
  exports: [KeycloakAdminClient, IdentitySourcesService],
})
export class IdentitySourcesModule {}
