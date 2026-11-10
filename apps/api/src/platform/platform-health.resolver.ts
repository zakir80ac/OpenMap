// REQ-PERF-005 (ADR-071) — Query.platformHealth for administrators: the platform's own health over a window.
import { Args, Query, Resolver } from '@nestjs/graphql';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { PlatformHealthService, type PlatformHealthView } from './platform-health.service.js';

@Resolver()
export class PlatformHealthResolver {
  constructor(private readonly service: PlatformHealthService) {}

  @Query('platformHealth')
  @Roles(ROLES.admin)
  platformHealth(@Args('windowMinutes') windowMinutes: unknown): Promise<PlatformHealthView> {
    return this.service.read(windowMinutes);
  }
}
