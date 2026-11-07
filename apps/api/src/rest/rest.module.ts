// REQ-CORE-019 (ADR-049) — REST v1 over the services GraphQL uses, from the contract's route table.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { ConnectivityModule } from '../connectivity/connectivity.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ServicesModule } from '../services/services.module.js';
import { RestController } from './rest.controller.js';

@Module({
  imports: [CiModule, GraphModule, ServicesModule, ConnectivityModule, MetricsModule],
  controllers: [RestController],
})
export class RestModule {}
