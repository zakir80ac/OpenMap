// REQ-CMDB-022 — the SaaS inventory bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { SaasDataFlowFieldsResolver, SaasResolver, SaasSubscriptionFieldsResolver, SaasTenantFieldsResolver } from './saas.resolver.js';
import { SaasService } from './saas.service.js';

@Module({
  imports: [CiModule],
  providers: [SaasService, SaasResolver, SaasTenantFieldsResolver, SaasSubscriptionFieldsResolver, SaasDataFlowFieldsResolver],
})
export class SaasModule {}
