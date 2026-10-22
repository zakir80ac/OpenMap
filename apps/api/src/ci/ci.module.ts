// REQ-CMDB-001 — CMDB bounded context.
import { Module } from '@nestjs/common';
import { CiLoaderFactory } from './ci.loaders.js';
import { PrismaCiRepository } from './ci.prisma-repository.js';
import { CI_REPOSITORY } from './ci.repository.js';
import { CiFieldsResolver, CiResolver, RelationshipFieldsResolver } from './ci.resolver.js';
import { CiService } from './ci.service.js';

@Module({
  providers: [{ provide: CI_REPOSITORY, useClass: PrismaCiRepository }, CiLoaderFactory, CiService, CiResolver, CiFieldsResolver, RelationshipFieldsResolver],
  exports: [CI_REPOSITORY, CiLoaderFactory, CiService],
})
export class CiModule {}
