// REQ-INT-017 (ADR-075) — the backup protection bounded context: covers, RPO judgement and gaps, read-only.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ProtectionResolver } from './protection.resolver.js';
import { ProtectionService } from './protection.service.js';

@Module({ imports: [CiModule, MetricsModule], providers: [ProtectionService, ProtectionResolver], exports: [ProtectionService] })
export class ProtectionModule {}
