// REQ-INT-019 (ADR-066) — backups bounded context: the sets the backup service wrote, read-only.
import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module.js';
import { BackupsResolver } from './backups.resolver.js';
import { BackupsService } from './backups.service.js';

@Module({ imports: [MetricsModule], providers: [BackupsService, BackupsResolver], exports: [BackupsService] })
export class BackupsModule {}
