// REQ-AI-005 (ADR-054) — Query.cloudAdvice and CloudRecommendation.ci.
import { Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import type { CiRecord } from '../ci/ci.types.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { CloudAdviceService, type CloudAdviceView, type CloudRecommendationView } from './cloud-advice.service.js';

@Resolver()
export class CloudAdviceResolver {
  constructor(
    private readonly service: CloudAdviceService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('cloudAdvice')
  cloudAdvice(): Promise<CloudAdviceView> {
    return this.service.advise(this.tenant.tenantId);
  }
}

@Resolver('CloudRecommendation')
export class CloudRecommendationFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  async ci(@Parent() r: CloudRecommendationView): Promise<CiRecord> {
    const ci = await this.tenant.loaders.ci.load(r.ciId);
    if (ci === null) throw new Error('cloud recommendation names a CI that no longer exists: ' + r.ciId);
    return ci;
  }
}
