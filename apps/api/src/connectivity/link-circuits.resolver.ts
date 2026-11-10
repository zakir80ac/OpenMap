// REQ-IPAM-007 (ADR-069) — Mutation.saveLinkCircuit (operators): the network circuit register's edit of one
// inter-site link CI. GraphQL leaves optional input fields out; the contract schema wants them present as null.
import { Args, Mutation, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { linkCircuitInputSchema } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import type { ConnectivityLinkView, LinkSharedRiskView } from './connectivity.service.js';
import { LinkCircuitsService } from './link-circuits.service.js';

const idArg = z.uuid();
const OPTIONAL = ['provider', 'carrierContractRef', 'slaLatencyMs', 'pathRef'] as const;

function withNulls(input: unknown): Record<string, unknown> {
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  return {
    ...Object.fromEntries(OPTIONAL.map((k) => [k, null])),
    ...record,
    circuitCiIds: record['circuitCiIds'] ?? [],
  };
}

@Resolver()
export class LinkCircuitsResolver {
  constructor(
    private readonly service: LinkCircuitsService,
    private readonly tenant: TenantContext,
  ) {}

  @Mutation('saveLinkCircuit')
  @Roles(ROLES.operator)
  saveLinkCircuit(
    @Args('linkId') linkId: unknown,
    @Args('input') input: unknown,
  ): Promise<ConnectivityLinkView> {
    return this.service.save(
      this.tenant.tenantId,
      this.tenant.username,
      parseInput(idArg, linkId, 'link id'),
      parseInput(linkCircuitInputSchema, withNulls(input), 'LinkCircuitInput'),
    );
  }
}

@Resolver('LinkSharedRisk')
export class LinkSharedRiskResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('other')
  other(@Parent() risk: LinkSharedRiskView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(risk.otherCiId);
  }
}
