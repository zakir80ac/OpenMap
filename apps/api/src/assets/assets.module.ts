// REQ-CMDB-002 REQ-CMDB-039 — asset management bounded context; the CMDB module supplies the CI repository so a
// manual asset can create its CI (ADR-023).
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { ASSETS_REPOSITORY, PrismaAssetsRepository } from './assets.repository.js';
import {
  AssetRecordFieldsResolver,
  AssetsResolver,
  CiAssetFieldResolver,
  InfraPlanFieldsResolver,
  PlanReceiptFieldsResolver,
  SupportContractFieldsResolver,
} from './assets.resolver.js';
import { AssetsService } from './assets.service.js';

@Module({
  imports: [CiModule],
  providers: [
    { provide: ASSETS_REPOSITORY, useClass: PrismaAssetsRepository },
    AssetsService,
    AssetsResolver,
    AssetRecordFieldsResolver,
    InfraPlanFieldsResolver,
    PlanReceiptFieldsResolver,
    SupportContractFieldsResolver,
    CiAssetFieldResolver,
  ],
  exports: [AssetsService],
})
export class AssetsModule {}
