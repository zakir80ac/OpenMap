// REQ-DEP-001 — dependency graph bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { ServicesModule } from '../services/services.module.js';
import { LAYER_PREFERENCES, PrismaLayerPreferenceRepository } from './graph.repository.js';
import { GraphResolver } from './graph.resolver.js';
import { GraphQueryService } from './graph.service.js';

@Module({
  imports: [CiModule, ServicesModule],
  providers: [{ provide: LAYER_PREFERENCES, useClass: PrismaLayerPreferenceRepository }, GraphQueryService, GraphResolver],
  exports: [GraphQueryService],
})
export class GraphModule {}
