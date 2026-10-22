// REQ-UI-019 REQ-CORE-012 — tenant settings over GraphQL (ADR-011): every signed-in role reads them, administrators
// change them. The partial input is validated with the zod schema the config package owns, so nothing the services
// would refuse to load can be stored; the mutation is audited by the global interceptor like every other.
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { tenantSettingsSchema, type TenantSettings } from '@openmap/config';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { parseInput } from '../common/validation.js';
import { TenantSettingsService } from './tenant-settings.service.js';
import { TenantContext } from './tenant.context.js';

const tenantSettingsInputSchema = tenantSettingsSchema.partial();

/** GraphQL sends an explicit null for a nullable field the client left empty; null means "keep", like omission. */
export function withoutNulls(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object') return {};
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined));
}

@Resolver()
export class TenantSettingsResolver {
  constructor(
    private readonly settings: TenantSettingsService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('tenantSettings')
  tenantSettings(): Promise<TenantSettings> {
    return this.settings.get(this.tenant.tenantId);
  }

  @Mutation('updateTenantSettings')
  @Roles(ROLES.admin)
  updateTenantSettings(@Args('input') input: unknown): Promise<TenantSettings> {
    const parsed = parseInput(tenantSettingsInputSchema, withoutNulls(input), 'updateTenantSettings input');
    // zod's partial() types every key as possibly undefined; the service takes a Partial with exact optional keys.
    const patch = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as Partial<TenantSettings>;
    return this.settings.update(this.tenant.tenantId, patch);
  }
}
