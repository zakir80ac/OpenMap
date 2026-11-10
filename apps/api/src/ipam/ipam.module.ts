// REQ-IPAM-001 REQ-IPAM-004 REQ-IPAM-005 — IPAM bounded context: subnets and addresses, switch ports, MAC lookup,
// firewall rules and policy objects.
import { Module } from '@nestjs/common';
import { CiModule } from '../ci/ci.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import {
  FirewallCheckResultResolver,
  FirewallDeviceResolver,
  FirewallObjectResolver,
  FirewallPolicyResolver,
  FirewallResolver,
  FirewallRuleResolver,
} from './firewall.resolver.js';
import { FirewallService } from './firewall.service.js';
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
    FirewallService,
    FirewallResolver,
    FirewallDeviceResolver,
    FirewallPolicyResolver,
    FirewallRuleResolver,
    FirewallObjectResolver,
    FirewallCheckResultResolver,
  ],
  exports: [IpamService],
})
export class IpamModule {}
