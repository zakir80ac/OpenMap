// REQ-CMDB-001 — CMDB bounded context.
import { Module } from '@nestjs/common';
import { CiLoaderFactory } from './ci.loaders.js';
import { PrismaCiRepository } from './ci.prisma-repository.js';
import { CI_REPOSITORY } from './ci.repository.js';
import { CiFieldsResolver, CiResolver, RelationshipFieldsResolver } from './ci.resolver.js';
import { CiService } from './ci.service.js';
import { LAYER_PREFERENCES, PrismaLayerPreferenceRepository } from '../graph/graph.repository.js';

@Module({
  providers: [{ provide: CI_REPOSITORY, useClass: PrismaCiRepository }, { provide: LAYER_PREFERENCES, useClass: PrismaLayerPreferenceRepository }, CiLoaderFactory, CiService, CiResolver, CiFieldsResolver, RelationshipFieldsResolver],
  exports: [CI_REPOSITORY, LAYER_PREFERENCES, CiLoaderFactory, CiService],
})
export class CiModule {}
