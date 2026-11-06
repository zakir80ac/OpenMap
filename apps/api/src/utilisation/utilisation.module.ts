// REQ-CMDB-034 — the resource utilisation bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { CiUtilisationFieldResolver, UtilisationResolver, UtilisationRowFieldsResolver } from './utilisation.resolver.js';
import { UtilisationService } from './utilisation.service.js';

@Module({
  imports: [CiModule],
  providers: [UtilisationService, UtilisationResolver, CiUtilisationFieldResolver, UtilisationRowFieldsResolver],
})
export class UtilisationModule {}
