// REQ-AI-003 (ADR-053) — anomaly rules over discovery and health events.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { AnomalyFindingFieldsResolver, AnomalyResolver } from './anomaly.resolver.js';
import { AnomalyService } from './anomaly.service.js';

@Module({
  imports: [CiModule, MetricsModule],
  providers: [AnomalyService, AnomalyResolver, AnomalyFindingFieldsResolver],
})
export class AnomalyModule {}
