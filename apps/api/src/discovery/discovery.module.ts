// REQ-DISC-029 — discovery bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { DISCOVERY_REPOSITORY, PrismaDiscoveryRepository } from './discovery.repository.js';
import { DiscoveryJobFieldsResolver, DiscoveryNodeFieldsResolver, DiscoveryResolver } from './discovery.resolver.js';
import { DiscoveryService } from './discovery.service.js';

@Module({
  imports: [CiModule],
  providers: [{ provide: DISCOVERY_REPOSITORY, useClass: PrismaDiscoveryRepository }, DiscoveryService, DiscoveryResolver, DiscoveryNodeFieldsResolver, DiscoveryJobFieldsResolver],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
