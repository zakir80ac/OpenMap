// REQ-IPAM-001 — IPAM bounded context.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { IpamResolver, SubnetFieldsResolver } from './ipam.resolver.js';
import { IpamService } from './ipam.service.js';

@Module({ imports: [CiModule], providers: [IpamService, IpamResolver, SubnetFieldsResolver], exports: [IpamService] })
export class IpamModule {}
