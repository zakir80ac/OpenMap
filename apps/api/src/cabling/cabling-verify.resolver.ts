// REQ-DCIM-008 (ADR-062) — Query.cablingVerification and Query.cablingLabelsCsv, and the field resolver that loads an
// observed port's CI through the request's CI loader.
import { Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import type { CiRecord } from '../ci/ci.types.js';
import { TenantContext } from '../tenant/tenant.context.js';
import {
  CablingVerificationService,
  type CablingVerificationView,
  type ObservedPortView,
} from './cabling-verify.service.js';

@Resolver()
export class CablingVerificationResolver {
  constructor(
    private readonly service: CablingVerificationService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('cablingVerification')
  cablingVerification(): Promise<CablingVerificationView> {
    return this.service.verification(this.tenant.tenantId);
  }

  @Query('cablingLabelsCsv')
  cablingLabelsCsv(): Promise<string> {
    return this.service.labelsCsv(this.tenant.tenantId);
  }
}

@Resolver('ObservedPort')
export class ObservedPortResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() port: ObservedPortView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(port.ciId);
  }
}
