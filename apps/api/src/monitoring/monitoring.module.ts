// REQ-INT-012 (ADR-073) — monitoring event ingest bounded context: the inbound endpoint, the alert list and mappings.
import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { MonitoringIngestController } from './monitoring-ingest.controller.js';
import { MonitoringAlertFieldsResolver, MonitoringMappingFieldsResolver, MonitoringResolver } from './monitoring.resolver.js';
import { MonitoringService } from './monitoring.service.js';

@Module({
  imports: [IntegrationsModule, MetricsModule],
  controllers: [MonitoringIngestController],
  providers: [MonitoringService, MonitoringResolver, MonitoringAlertFieldsResolver, MonitoringMappingFieldsResolver],
})
export class MonitoringModule {}
