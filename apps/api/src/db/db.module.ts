// REQ-CORE-012 — persistence module: Postgres (Prisma) and the dependency graph (Memgraph).
import { Global, Module } from '@nestjs/common';
import { GraphService } from './graph.service.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, GraphService],
  exports: [PrismaService, GraphService],
})
export class DbModule {}
