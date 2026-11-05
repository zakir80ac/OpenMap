// REQ-CMDB-015 — Query.customFieldDefinitions, Mutation.upsertCustomFieldDefinition / deleteCustomFieldDefinition
// (administrators) and Mutation.setCiCustomFields (operators). Inputs are validated with the contract's schema.
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ciTypeSchema, customFieldDefinitionInputSchema } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { CustomFieldsService, type CustomFieldDefinitionView } from './custom-fields.service.js';

const idArg = z.uuid();
const optionalId = z.uuid().nullish();
const typeArg = ciTypeSchema.nullish();
const valuesArg = z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()]));

@Resolver()
export class CustomFieldsResolver {
  constructor(
    private readonly service: CustomFieldsService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('customFieldDefinitions')
  definitions(@Args('type') type: unknown): Promise<CustomFieldDefinitionView[]> {
    return this.service.definitions(this.tenant.tenantId, parseInput(typeArg, type, 'type') ?? null);
  }

  @Mutation('upsertCustomFieldDefinition')
  @Roles(ROLES.admin)
  upsert(@Args('id') id: unknown, @Args('input') input: unknown): Promise<CustomFieldDefinitionView> {
    return this.service.upsert(this.tenant.tenantId, parseInput(optionalId, id, 'custom field id') ?? null, parseInput(customFieldDefinitionInputSchema, input, 'CustomFieldDefinitionInput'));
  }

  @Mutation('deleteCustomFieldDefinition')
  @Roles(ROLES.admin)
  remove(@Args('id') id: unknown): Promise<boolean> {
    return this.service.remove(this.tenant.tenantId, parseInput(idArg, id, 'custom field id'));
  }

  @Mutation('setCiCustomFields')
  @Roles(ROLES.operator)
  setValues(@Args('ciId') ciId: unknown, @Args('values') values: unknown): Promise<CiRecord> {
    return this.service.setValues(
      { tenantId: this.tenant.tenantId, username: this.tenant.username, requestId: this.tenant.requestId },
      parseInput(idArg, ciId, 'ciId'),
      parseInput(valuesArg, values, 'custom field values'),
    );
  }
}
