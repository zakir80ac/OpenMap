// REQ-CORE-012 REQ-UI-019 — tenant scoping module: request-scoped TenantContext, tenant settings and their GraphQL resolver.
import { Global, Module } from '@nestjs/common';
import { TenantSettingsResolver } from './tenant-settings.resolver.js';
import { TenantSettingsService } from './tenant-settings.service.js';
import { TenantContext } from './tenant.context.js';

@Global()
@Module({ providers: [TenantContext, TenantSettingsService, TenantSettingsResolver], exports: [TenantContext, TenantSettingsService] })
export class TenantModule {}
