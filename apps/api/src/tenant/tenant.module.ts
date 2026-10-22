// REQ-CORE-012 — tenant scoping module: request-scoped TenantContext and tenant settings.
import { Global, Module } from '@nestjs/common';
import { TenantSettingsService } from './tenant-settings.service.js';
import { TenantContext } from './tenant.context.js';

@Global()
@Module({ providers: [TenantContext, TenantSettingsService], exports: [TenantContext, TenantSettingsService] })
export class TenantModule {}
