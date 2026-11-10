// REQ-CORE-012 REQ-CMDB-038 — persistence module: Postgres (Prisma), the dependency graph (Memgraph) and the
// analytics store (ClickHouse, read side).
import { Global, Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ClickHouseService } from './clickhouse.service.js';
import { FieldCipherService } from './field-cipher.service.js';
import { GraphService } from './graph.service.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  imports: [MetricsModule],
  providers: [PrismaService, GraphService, ClickHouseService, FieldCipherService],
  exports: [PrismaService, GraphService, ClickHouseService, FieldCipherService],
})
export class DbModule {}
