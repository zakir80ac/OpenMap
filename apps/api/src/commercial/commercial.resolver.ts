// REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 (ADR-035) — Query.contracts / contract / vendors / vendor /
// costCentres, the commercial mutations (operators), and the Contract field resolvers (vendor, cost centre).
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import type { AssetRecordView } from '../assets/assets.types.js';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import {
  contractFilterSchema,
  setAssetContractArgsSchema,
  upsertContractArgsSchema,
  upsertCostCentreArgsSchema,
  upsertVendorArgsSchema,
  vendorContactInputSchema,
} from './commercial.schemas.js';
import { CommercialService } from './commercial.service.js';
import type { ContractView, CostCentreView, VendorContactView, VendorDetailView, VendorView } from './commercial.types.js';

const idArg = z.uuid();
const textArg = z.string().nullish();

/** GraphQL leaves an optional input field out; the record schemas want it present as null. */
function withNulls(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  return { ...Object.fromEntries(keys.map((k) => [k, null])), ...record };
}

const CONTRACT_OPTIONAL = ['costCentreId', 'level', 'responseMinutes', 'noticeDays', 'annualCost', 'currency'] as const;
const VENDOR_OPTIONAL = ['category', 'supportPortal', 'accountManager'] as const;
const COST_CENTRE_OPTIONAL = ['owner', 'annualBudget', 'currency'] as const;

@Resolver()
export class CommercialResolver {
  constructor(
    private readonly service: CommercialService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('contracts')
  contracts(@Args('filter') filter: unknown): Promise<ContractView[]> {
    const f = parseInput(contractFilterSchema, filter ?? {}, 'ContractFilter');
    return this.service.contracts(this.tenant.tenantId, {
      kinds: f.kinds ?? [],
      vendorId: f.vendorId ?? null,
      costCentreId: f.costCentreId ?? null,
      text: f.text ?? null,
      expiringWithinDays: f.expiringWithinDays ?? null,
      expired: f.expired ?? null,
    });
  }

  @Query('contract')
  contract(@Args('id') id: unknown): Promise<ContractView | null> {
    return this.service.contract(this.tenant.tenantId, parseInput(idArg, id, 'contract id'));
  }

  @Query('vendors')
  vendors(@Args('text') text: unknown): Promise<VendorView[]> {
    return this.service.vendors(this.tenant.tenantId, parseInput(textArg, text, 'vendors text') ?? null);
  }

  @Query('vendor')
  vendor(@Args('id') id: unknown): Promise<VendorDetailView | null> {
    return this.service.vendor(this.tenant.tenantId, parseInput(idArg, id, 'vendor id'));
  }

  @Query('costCentres')
  costCentres(): Promise<CostCentreView[]> {
    return this.service.costCentres(this.tenant.tenantId);
  }

  @Mutation('upsertContract')
  @Roles(ROLES.operator)
  upsertContract(@Args('id') id: unknown, @Args('input') input: unknown): Promise<ContractView> {
    const a = parseInput(upsertContractArgsSchema, { id, input: withNulls(input, CONTRACT_OPTIONAL) }, 'upsertContract arguments');
    return this.service.upsertContract(this.tenant.tenantId, this.tenant.username, a.id ?? null, a.input);
  }

  @Mutation('upsertVendor')
  @Roles(ROLES.operator)
  upsertVendor(@Args('id') id: unknown, @Args('input') input: unknown): Promise<VendorView> {
    const a = parseInput(upsertVendorArgsSchema, { id, input: withNulls(input, VENDOR_OPTIONAL) }, 'upsertVendor arguments');
    return this.service.upsertVendor(this.tenant.tenantId, this.tenant.username, a.id ?? null, a.input);
  }

  @Mutation('upsertCostCentre')
  @Roles(ROLES.operator)
  upsertCostCentre(@Args('id') id: unknown, @Args('input') input: unknown): Promise<CostCentreView> {
    const a = parseInput(upsertCostCentreArgsSchema, { id, input: withNulls(input, COST_CENTRE_OPTIONAL) }, 'upsertCostCentre arguments');
    return this.service.upsertCostCentre(this.tenant.tenantId, this.tenant.username, a.id ?? null, a.input);
  }

  @Mutation('upsertVendorContact')
  @Roles(ROLES.operator)
  upsertVendorContact(@Args('input') input: unknown): Promise<VendorContactView> {
    return this.service.upsertVendorContact(this.tenant.tenantId, parseInput(vendorContactInputSchema, input, 'VendorContactInput'));
  }

  @Mutation('deleteVendorContact')
  @Roles(ROLES.operator)
  deleteVendorContact(@Args('id') id: unknown): Promise<boolean> {
    return this.service.deleteVendorContact(this.tenant.tenantId, parseInput(idArg, id, 'vendor contact id'));
  }

  @Mutation('setAssetContract')
  @Roles(ROLES.operator)
  setAssetContract(@Args('assetId') assetId: unknown, @Args('contractId') contractId: unknown): Promise<AssetRecordView> {
    const a = parseInput(setAssetContractArgsSchema, { assetId, contractId: contractId ?? null }, 'setAssetContract arguments');
    return this.service.setAssetContract(this.tenant.tenantId, this.tenant.username, a.assetId, a.contractId);
  }
}

@Resolver('Contract')
export class ContractFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('vendor')
  vendor(@Parent() contract: ContractView): Promise<CiRecord | null> {
    return contract.vendorCiId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(contract.vendorCiId);
  }

  @ResolveField('costCentre')
  costCentre(@Parent() contract: ContractView): Promise<CiRecord | null> {
    return contract.costCentreCiId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(contract.costCentreCiId);
  }
}
