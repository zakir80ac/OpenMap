// REQ-IPAM-003 (ADR-055) — two-way DNS sync: zone sync settings and record changes.
import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module.js';
import { DnsSyncResolver } from './dns-sync.resolver.js';
import { DnsSyncService } from './dns-sync.service.js';

@Module({
  imports: [MetricsModule],
  providers: [DnsSyncService, DnsSyncResolver],
})
export class DnsSyncModule {}
