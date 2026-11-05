// REQ-DEP-001 — Query.impact / Query.path / Query.layers / Query.networkTopology (ADR-030) and Mutation.setLayerVisibility.
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { TOPOLOGY } from '@openmap/constants';
import { ciLayerSchema } from '@openmap/contracts';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { directionSchema } from '../ci/ci.schemas.js';
import type { RelationshipRecord } from '../ci/ci.types.js';
import { parseInput } from '../common/validation.js';
import { TenantContext } from '../tenant/tenant.context.js';
import { GraphQueryService } from './graph.service.js';
import type { ImpactResultView, LayerSummaryView } from './graph.types.js';
import { TopologyService, type NetworkTopologyView } from './topology.service.js';

const impactArgs = z.object({
  ciId: z.uuid(),
  direction: directionSchema.nullish(),
  maxDepth: z.number().int().min(0).nullish(),
  asOf: z.iso.datetime({ offset: true }).nullish(),
});
const pathArgs = z.object({ fromCiId: z.uuid(), toCiId: z.uuid() });
const visibilityArgs = z.object({ layer: ciLayerSchema, visible: z.boolean() });
const topologyArgs = z.object({ layer: z.enum(TOPOLOGY.layers).nullish(), siteId: z.uuid().nullish(), includeHosts: z.boolean().nullish() });

@Resolver()
export class GraphResolver {
  constructor(
    private readonly service: GraphQueryService,
    private readonly topologies: TopologyService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('networkTopology')
  networkTopology(@Args('layer') layer: unknown, @Args('siteId') siteId: unknown, @Args('includeHosts') includeHosts: unknown): Promise<NetworkTopologyView> {
    const a = parseInput(topologyArgs, { layer, siteId, includeHosts }, 'networkTopology arguments');
    return this.topologies.topology(this.tenant.tenantId, a.layer ?? 'l2', a.siteId ?? null, a.includeHosts ?? false);
  }

  @Query('impact')
  impact(@Args('ciId') ciId: unknown, @Args('direction') direction: unknown, @Args('maxDepth') maxDepth: unknown, @Args('asOf') asOf: unknown): Promise<ImpactResultView> {
    const a = parseInput(impactArgs, { ciId, direction, maxDepth, asOf }, 'impact arguments');
    return this.service.impact(this.tenant.tenantId, a.ciId, a.direction ?? 'upstream', a.maxDepth ?? 0, a.asOf ?? null);
  }

  @Query('path')
  path(@Args('fromCiId') fromCiId: unknown, @Args('toCiId') toCiId: unknown): Promise<RelationshipRecord[]> {
    const a = parseInput(pathArgs, { fromCiId, toCiId }, 'path arguments');
    return this.service.path(this.tenant.tenantId, a.fromCiId, a.toCiId);
  }

  @Query('layers')
  layers(): Promise<LayerSummaryView[]> {
    return this.service.layers(this.tenant.tenantId, this.tenant.userId);
  }

  @Mutation('setLayerVisibility')
  @Roles(ROLES.analyst)
  setLayerVisibility(@Args('layer') layer: unknown, @Args('visible') visible: unknown): Promise<LayerSummaryView[]> {
    const a = parseInput(visibilityArgs, { layer, visible }, 'setLayerVisibility arguments');
    return this.service.setLayerVisibility(this.tenant.tenantId, this.tenant.userId, a.layer, a.visible);
  }
}
