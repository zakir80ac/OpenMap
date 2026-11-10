// REQ-CORE-019 (ADR-049) REQ-INT-011 (ADR-072) — REST v1 over the services GraphQL uses, from the contract's route
// table: the CMDB routes and the configuration-management inventory routes.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { ConnectivityModule } from '../connectivity/connectivity.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ServicesModule } from '../services/services.module.js';
import { InventoryController } from './inventory.controller.js';
import { RestController } from './rest.controller.js';

@Module({
  imports: [CiModule, GraphModule, ServicesModule, ConnectivityModule, MetricsModule, InventoryModule],
  controllers: [RestController, InventoryController],
})
export class RestModule {}
