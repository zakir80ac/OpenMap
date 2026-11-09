// REQ-DCIM-001 (ADR-056) — Query.cabling / cableTrace, the cabling mutations (operators) and the field resolvers that
// load endpoint, rack and hop CIs through the request's batched CI loader.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { cableEndpointSchema, cableInputSchema, circuitInputSchema, patchPanelInputSchema } from '@openmap/contracts';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import type { CiRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { CablingService } from './cabling.service.js';
import type { CableHopView, CableTraceView, CableView, CablingView, CircuitView, EndpointView, PatchPanelView } from './cabling.types.js';

const idArg = z.uuid();
const optionalId = z.uuid().nullish();

/** GraphQL leaves an optional input field out; the contract schemas want it present as null. */
function withNulls(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  return { ...Object.fromEntries(keys.map((k) => [k, null])), ...record };
}
const ENDPOINT_OPTIONAL = ['port', 'side'] as const;
function endpoint(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined ? null : withNulls(value, ENDPOINT_OPTIONAL);
}

@Resolver()
export class CablingResolver {
  constructor(
    private readonly service: CablingService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('cabling')
  cabling(): Promise<CablingView> {
    return this.service.cabling(this.tenant.tenantId);
  }

  @Query('cableTrace')
  cableTrace(@Args('endpoint') value: unknown): Promise<CableTraceView> {
    return this.service.trace(this.tenant.tenantId, parseInput(cableEndpointSchema, endpoint(value), 'CableEndpointInput'));
  }

  @Mutation('upsertPatchPanel')
  @Roles(ROLES.operator)
  upsertPatchPanel(@Args('id') id: unknown, @Args('input') input: unknown): Promise<PatchPanelView> {
    const panelId = parseInput(optionalId, id, 'patch panel id') ?? null;
    return this.service.upsertPatchPanel(this.tenant.tenantId, this.tenant.username, panelId, parseInput(patchPanelInputSchema, withNulls(input, ['uPosition']), 'PatchPanelInput'));
  }

  @Mutation('connectCable')
  @Roles(ROLES.operator)
  connectCable(@Args('input') input: unknown): Promise<CableView> {
    const record = withNulls(input, ['lengthM', 'colour']);
    const value = { ...record, a: endpoint(record['a']), b: endpoint(record['b']) };
    return this.service.connectCable(this.tenant.tenantId, this.tenant.username, parseInput(cableInputSchema, value, 'CableInput'));
  }

  @Mutation('disconnectCable')
  @Roles(ROLES.operator)
  disconnectCable(@Args('id') id: unknown): Promise<boolean> {
    return this.service.disconnectCable(this.tenant.tenantId, this.tenant.username, parseInput(idArg, id, 'cable id'));
  }

  @Mutation('removePatchPanel')
  @Roles(ROLES.operator)
  removePatchPanel(@Args('id') id: unknown): Promise<boolean> {
    return this.service.removePatchPanel(this.tenant.tenantId, this.tenant.username, parseInput(idArg, id, 'patch panel id'));
  }

  @Mutation('removeCircuit')
  @Roles(ROLES.operator)
  removeCircuit(@Args('id') id: unknown): Promise<boolean> {
    return this.service.removeCircuit(this.tenant.tenantId, this.tenant.username, parseInput(idArg, id, 'circuit id'));
  }

  @Mutation('upsertCircuit')
  @Roles(ROLES.operator)
  upsertCircuit(@Args('id') id: unknown, @Args('input') input: unknown): Promise<CircuitView> {
    const circuitId = parseInput(optionalId, id, 'circuit id') ?? null;
    const record = withNulls(input, ['bandwidthMbps', 'aEnd', 'zEnd', 'zEndDescription']);
    const value = { ...record, aEnd: endpoint(record['aEnd']), zEnd: endpoint(record['zEnd']) };
    return this.service.upsertCircuit(this.tenant.tenantId, this.tenant.username, circuitId, parseInput(circuitInputSchema, value, 'CircuitInput'));
  }
}

@Resolver('CableEndpoint')
export class CableEndpointResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('ci')
  ci(@Parent() endpoint: EndpointView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(endpoint.ciId);
  }
}

@Resolver('PatchPanel')
export class PatchPanelResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('rack')
  rack(@Parent() panel: PatchPanelView): Promise<CiRecord | null> {
    return panel.rackCiId === null ? Promise.resolve(null) : this.tenant.loaders.ci.load(panel.rackCiId);
  }
}

@Resolver('CableHop')
export class CableHopResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('via')
  via(@Parent() hop: CableHopView): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(hop.viaCiId);
  }
}
