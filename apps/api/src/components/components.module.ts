// REQ-CMDB-014 (ADR-037) — the device parts bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { CiComponentsFieldResolver, ComponentsResolver, HardwareComponentFieldsResolver } from './components.resolver.js';
import { ComponentsService } from './components.service.js';

@Module({
  imports: [CiModule],
  providers: [ComponentsService, ComponentsResolver, CiComponentsFieldResolver, HardwareComponentFieldsResolver],
})
export class ComponentsModule {}
