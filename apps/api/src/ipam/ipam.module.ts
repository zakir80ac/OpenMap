// REQ-IPAM-001 REQ-IPAM-004 — IPAM bounded context: subnets and addresses, switch ports, MAC lookup.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { IpamResolver, SubnetFieldsResolver } from './ipam.resolver.js';
import { IpamService } from './ipam.service.js';
import {
  LearnedMacResolver,
  MacSightingResolver,
  PortHistoryResolver,
  PortNeighbourResolver,
  SwitchPortResolver,
  SwitchPortsFieldsResolver,
  SwitchPortsResolver,
} from './switch-ports.resolver.js';
import { SwitchPortsService } from './switch-ports.service.js';
import { MetricsModule } from '../metrics/metrics.module.js';

@Module({
  imports: [CiModule, MetricsModule],
  providers: [
    IpamService,
    IpamResolver,
    SubnetFieldsResolver,
    SwitchPortsService,
    SwitchPortsResolver,
    SwitchPortsFieldsResolver,
    SwitchPortResolver,
    PortHistoryResolver,
    PortNeighbourResolver,
    LearnedMacResolver,
    MacSightingResolver,
  ],
  exports: [IpamService],
})
export class IpamModule {}
