// REQ-INT-011 (ADR-072) — dynamic inventory for configuration-management tools: the node read over the CMDB. The REST
// routes that serve it in each tool's format live in rest/inventory.controller.ts.
import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';

@Module({
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
