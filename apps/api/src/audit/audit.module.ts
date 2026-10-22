// REQ-SEC-005 — audit module: the service, the auditor-facing query and the global interceptor that records mutations.
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsModule } from '../metrics/metrics.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditResolver } from './audit.resolver.js';
import { AuditService } from './audit.service.js';

@Module({
  imports: [MetricsModule, OutboxModule, TenantModule],
  providers: [AuditService, AuditResolver, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  exports: [AuditService],
})
export class AuditModule {}
