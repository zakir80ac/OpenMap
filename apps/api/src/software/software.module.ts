// REQ-UI-015 REQ-UI-016 — software, licence and vulnerability bounded context (ADR-013).
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { SoftwareResolver } from './software.resolver.js';
import { SoftwareService } from './software.service.js';

@Module({ imports: [CiModule, GraphModule], providers: [SoftwareService, SoftwareResolver], exports: [SoftwareService] })
export class SoftwareModule {}
