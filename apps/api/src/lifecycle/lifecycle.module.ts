// REQ-CMDB-023 REQ-CMDB-025 (ADR-039) — the product lifecycle bounded context.
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CiModule } from '../ci/ci.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { LifecycleReleaseFieldsResolver, LifecycleResolver } from './lifecycle.resolver.js';
import { LifecycleService } from './lifecycle.service.js';

@Module({
  imports: [CiModule, IntegrationsModule, AuditModule],
  providers: [LifecycleService, LifecycleResolver, LifecycleReleaseFieldsResolver],
})
export class LifecycleModule {}
