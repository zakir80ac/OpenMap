// REQ-CMDB-015 — custom fields bounded context: tenant-defined fields and their values on CIs.
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { CustomFieldsResolver } from './custom-fields.resolver.js';
import { CustomFieldsService } from './custom-fields.service.js';

@Module({
  imports: [DbModule, TenantModule],
  providers: [CustomFieldsService, CustomFieldsResolver],
  exports: [CustomFieldsService],
})
export class CustomFieldsModule {}
