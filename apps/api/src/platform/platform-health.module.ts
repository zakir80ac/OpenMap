// REQ-PERF-005 (ADR-071) — platform health bounded context: the deployment's Prometheus and perf results, read-only.
import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module.js';
import { PlatformHealthResolver } from './platform-health.resolver.js';
import { PlatformHealthService } from './platform-health.service.js';

@Module({ imports: [MetricsModule], providers: [PlatformHealthService, PlatformHealthResolver], exports: [PlatformHealthService] })
export class PlatformHealthModule {}
