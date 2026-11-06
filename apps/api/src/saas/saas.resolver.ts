// REQ-CMDB-022 — Query.saasInventory and the CI fields of its tenants, subscriptions and data flows.
import { Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import type { CiRecord } from '../ci/ci.types.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { SaasService, type SaasDataFlowView, type SaasInventoryView, type SaasSubscriptionView, type SaasTenantView } from './saas.service.js';

async function ciOf(tenant: TenantContext, id: string): Promise<CiRecord> {
  const ci = await tenant.loaders.ci.load(id);
  if (ci === null) throw new Error('SaaS inventory names CI ' + id + ' that no longer exists');
  return ci;
}

@Resolver()
export class SaasResolver {
  constructor(
    private readonly service: SaasService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('saasInventory')
  inventory(): Promise<SaasInventoryView> {
    return this.service.inventory(this.tenant.tenantId);
  }
}

@Resolver('SaasTenant')
export class SaasTenantFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() t: SaasTenantView): Promise<CiRecord> {
    return ciOf(this.tenant, t.ciId);
  }
}

@Resolver('SaasSubscription')
export class SaasSubscriptionFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() s: SaasSubscriptionView): Promise<CiRecord> {
    return ciOf(this.tenant, s.ciId);
  }
}

@Resolver('SaasDataFlow')
export class SaasDataFlowFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('application')
  application(@Parent() f: SaasDataFlowView): Promise<CiRecord> {
    return ciOf(this.tenant, f.applicationId);
  }
}
