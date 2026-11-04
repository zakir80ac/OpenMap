// REQ-DCIM-001 — DCIM bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { DcimResolver } from './dcim.resolver.js';
import { DcimService } from './dcim.service.js';

@Module({ imports: [CiModule], providers: [DcimService, DcimResolver], exports: [DcimService] })
export class DcimModule {}
