// REQ-CMDB-002 REQ-CMDB-039 REQ-CMDB-040 — Query.assets / assetSummary / plans, the plan and asset mutations
// (stage, details, manual creation), and the AssetRecord / InfraPlan / SupportContract field resolvers plus Ci.asset.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import {
  assetPageArgsSchema,
  assetsArgsSchema,
  manualAssetInputSchema,
  planInputSchema,
  plansArgsSchema,
  setAssetStageSchema,
  setPlanStatusSchema,
  updateAssetArgsSchema,
} from './assets.schemas.js';
import { AssetsService } from './assets.service.js';
import type {
  AssetAuditView,
  AssetPageView,
  AssetRecordView,
  AssetSummaryView,
  InfraPlanView,
  SupportContractView,
  VendorContactView,
} from './assets.types.js';

@Resolver()
export class AssetsResolver {
  constructor(
    private readonly service: AssetsService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('assets')
  assets(
    @Args('filter') filter: unknown,
    @Args('stage') stage: unknown,
    @Args('warrantyExpiringWithinDays') days: unknown,
    @Args('first') first: unknown,
    @Args('after') after: unknown,
  ): Promise<AssetRecordView[]> {
    const a = parseInput(
      assetsArgsSchema,
      { filter, stage, warrantyExpiringWithinDays: days, first, after },
      'assets arguments',
    );
    return this.service.assets(
      this.tenant.tenantId,
      a.filter ?? null,
      a.stage ?? [],
      a.warrantyExpiringWithinDays ?? null,
      a.first,
      a.after,
    );
  }

  @Query('assetPage')
  assetPage(
    @Args('filter') filter: unknown,
    @Args('page') page: unknown,
    @Args('pageSize') pageSize: unknown,
  ): Promise<AssetPageView> {
    const a = parseInput(assetPageArgsSchema, { filter, page, pageSize }, 'assetPage arguments');
    return this.service.assetPage(this.tenant.tenantId, a.filter ?? null, a.page, a.pageSize);
  }

  @Query('assetSummary')
  assetSummary(): Promise<AssetSummaryView[]> {
    return this.service.summary(this.tenant.tenantId);
  }

  @Query('plans')
  plans(@Args('status') status: unknown): Promise<InfraPlanView[]> {
    const a = parseInput(plansArgsSchema, { status }, 'plans arguments');
    return this.service.plans(this.tenant.tenantId, a.status ?? []);
  }

  @Mutation('createPlan')
  @Roles(ROLES.operator)
  createPlan(@Args('input') input: unknown): Promise<InfraPlanView> {
    return this.service.createPlan(
      this.tenant.tenantId,
      this.tenant.username,
      parseInput(planInputSchema, input, 'PlanInput'),
    );
  }

  @Mutation('setPlanStatus')
  @Roles(ROLES.operator)
  setPlanStatus(@Args('planId') planId: unknown, @Args('status') status: unknown): Promise<InfraPlanView> {
    const a = parseInput(setPlanStatusSchema, { planId, status }, 'setPlanStatus arguments');
    return this.service.setPlanStatus(this.tenant.tenantId, this.tenant.username, a.planId, a.status);
  }

  @Mutation('setAssetStage')
  @Roles(ROLES.operator)
  setAssetStage(
    @Args('assetId') assetId: unknown,
    @Args('stage') stage: unknown,
    @Args('note') note: unknown,
  ): Promise<AssetRecordView> {
    const a = parseInput(setAssetStageSchema, { assetId, stage, note }, 'setAssetStage arguments');
    return this.service.setAssetStage(
      this.tenant.tenantId,
      this.tenant.username,
      a.assetId,
      a.stage,
      a.note ?? null,
    );
  }

  @Mutation('updateAsset')
  @Roles(ROLES.operator)
  updateAsset(@Args('assetId') assetId: unknown, @Args('input') input: unknown): Promise<AssetRecordView> {
    const a = parseInput(updateAssetArgsSchema, { assetId, input }, 'updateAsset arguments');
    return this.service.updateAsset(this.tenant.tenantId, this.tenant.username, a.assetId, a.input);
  }

  @Mutation('createAsset')
  @Roles(ROLES.operator)
  createAsset(@Args('input') input: unknown): Promise<AssetRecordView> {
    return this.service.createAsset(
      this.tenant.tenantId,
      this.tenant.username,
      parseInput(manualAssetInputSchema, input, 'ManualAssetInput'),
    );
  }
}

@Resolver('AssetRecord')
export class AssetRecordFieldsResolver {
  constructor(
    private readonly service: AssetsService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('ci')
  ci(@Parent() asset: AssetRecordView): Promise<CiRecord | null> {
    return asset.ciId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(asset.ciId);
  }

  @ResolveField('locationCi')
  locationCi(@Parent() asset: AssetRecordView): Promise<CiRecord | null> {
    return asset.locationCiId === null
      ? Promise.resolve(null)
      : this.tenant.loaders.ci.load(asset.locationCiId);
  }

  @ResolveField('supportContract')
  supportContract(@Parent() asset: AssetRecordView): Promise<SupportContractView | null> {
    return asset.supportContractId === null
      ? Promise.resolve(null)
      : this.service.supportContract(this.tenant.tenantId, asset.supportContractId);
  }

  @ResolveField('supportEndsAt')
  async supportEndsAt(@Parent() asset: AssetRecordView): Promise<string | null> {
    if (asset.supportEndsAt !== null) return asset.supportEndsAt;
    if (asset.supportContractId === null) return null;
    const contract = await this.service.supportContract(this.tenant.tenantId, asset.supportContractId);
    return contract?.endsAt ?? null;
  }

  @ResolveField('plan')
  plan(@Parent() asset: AssetRecordView): Promise<InfraPlanView | null> {
    return asset.planId === null
      ? Promise.resolve(null)
      : this.service.plan(this.tenant.tenantId, asset.planId);
  }

  @ResolveField('audits')
  audits(@Parent() asset: AssetRecordView): Promise<AssetAuditView[]> {
    return this.service.audits(this.tenant.tenantId, asset.id);
  }
}

@Resolver('InfraPlan')
export class InfraPlanFieldsResolver {
  constructor(
    private readonly service: AssetsService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('targetSite')
  targetSite(@Parent() plan: InfraPlanView): Promise<CiRecord | null> {
    return plan.targetSiteCiId === null
      ? Promise.resolve(null)
      : this.tenant.loaders.ci.load(plan.targetSiteCiId);
  }

  @ResolveField('targetRacks')
  async targetRacks(@Parent() plan: InfraPlanView): Promise<CiRecord[]> {
    return (await this.tenant.loaders.ci.loadMany(plan.targetRackCiIds)).filter(
      (c): c is CiRecord => c !== null,
    );
  }

  @ResolveField('assets')
  assets(@Parent() plan: InfraPlanView): Promise<AssetRecordView[]> {
    return this.service.assetsByPlan(this.tenant.tenantId, plan.id);
  }
}

@Resolver('SupportContract')
export class SupportContractFieldsResolver {
  constructor(
    private readonly service: AssetsService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('vendor')
  vendor(@Parent() contract: SupportContractView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(contract.vendorCiId);
  }

  @ResolveField('primaryContact')
  primaryContact(@Parent() contract: SupportContractView): Promise<VendorContactView | null> {
    return contract.primaryContactId === null
      ? Promise.resolve(null)
      : this.service.vendorContact(this.tenant.tenantId, contract.primaryContactId);
  }
}

@Resolver('Ci')
export class CiAssetFieldResolver {
  constructor(
    private readonly service: AssetsService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('asset')
  async asset(@Parent() ci: CiRecord): Promise<AssetRecordView | null> {
    const [first] = await this.service.assetsByCiIds(this.tenant.tenantId, [ci.id]);
    return first ?? null;
  }
}
