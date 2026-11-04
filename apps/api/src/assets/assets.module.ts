// REQ-CMDB-002 — asset management bounded context.
import { Module } from '@nestjs/common';
import { ASSETS_REPOSITORY, PrismaAssetsRepository } from './assets.repository.js';
import { AssetRecordFieldsResolver, AssetsResolver, CiAssetFieldResolver, InfraPlanFieldsResolver, SupportContractFieldsResolver } from './assets.resolver.js';
import { AssetsService } from './assets.service.js';

@Module({
  providers: [{ provide: ASSETS_REPOSITORY, useClass: PrismaAssetsRepository }, AssetsService, AssetsResolver, AssetRecordFieldsResolver, InfraPlanFieldsResolver, SupportContractFieldsResolver, CiAssetFieldResolver],
  exports: [AssetsService],
})
export class AssetsModule {}
