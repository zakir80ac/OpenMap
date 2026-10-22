// REQ-UI-017 — analytics module: Superset provisioning and guest tokens behind the `analyticsEmbed` query.
import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module.js';
import { AnalyticsResolver } from './analytics.resolver.js';
import { AnalyticsService } from './analytics.service.js';

@Module({ imports: [MetricsModule], providers: [AnalyticsService, AnalyticsResolver], exports: [AnalyticsService] })
export class AnalyticsModule {}
