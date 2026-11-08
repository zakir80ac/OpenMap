// REQ-UI-027 — the health and telemetry fleet bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { FleetRowFieldsResolver, TelemetryResolver } from './telemetry.resolver.js';
import { TelemetryService } from './telemetry.service.js';

@Module({
  imports: [CiModule, MetricsModule],
  providers: [TelemetryService, TelemetryResolver, FleetRowFieldsResolver],
})
export class TelemetryModule {}
