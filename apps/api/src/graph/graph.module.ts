// REQ-DEP-001 — dependency graph bounded context: impact, paths, layer visibility and the network topology maps.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { DbModule } from '../db/db.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ServicesModule } from '../services/services.module.js';
import { GraphResolver } from './graph.resolver.js';
import { GraphQueryService } from './graph.service.js';
import { ApplicationMapService } from './application-map.service.js';
import { TopologyService } from './topology.service.js';

@Module({
  imports: [CiModule, DbModule, MetricsModule, ServicesModule],
  providers: [GraphQueryService, TopologyService, ApplicationMapService, GraphResolver],
  exports: [GraphQueryService],
})
export class GraphModule {}
