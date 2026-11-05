// REQ-CMDB-001 REQ-CMDB-038 — CMDB resolvers for the frozen schema: Query.ci/cis/search/unknownCis/vulnerabilities,
// the CI mutations, and the Ci / Relationship field resolvers (health, headline metric, relationships, history).
// Every call is scoped by TenantContext.
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { CI_EDIT, TIME } from '@openmap/constants';
import { LAYER_HEADLINE_METRIC } from '@openmap/contracts';
import { parseInput } from '../common/validation.js';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { TenantContext } from '../tenant/tenant.context.js';
import {
  ciFilterSchema,
  createRelationshipSchema,
  historyArgsSchema,
  labelCiSchema,
  pagingSchema,
  relationshipArgsSchema,
  searchArgsSchema,
  setCiCodeSchema,
  setLifecycleSchema,
  setTagsSchema,
  tagListSchema,
  updateAttributesSchema,
  vulnerabilityArgsSchema,
} from './ci.schemas.js';
import { CiService } from './ci.service.js';
import type {
  CiRecord,
  CiVersionRecord,
  Connection,
  HeadlineMetricRecord,
  HealthState,
  RelationshipRecord,
  SearchHitRecord,
  VulnerabilityRecord,
} from './ci.types.js';
import { z } from 'zod';

const idSchema = z.object({ id: z.uuid(), asOf: z.iso.datetime({ offset: true }).nullish() });
const uuidSchema = z.uuid();

@Resolver()
export class CiResolver {
  constructor(
    private readonly service: CiService,
    private readonly tenant: TenantContext,
  ) {}

  @Query('ci')
  ci(@Args('id') id: unknown, @Args('asOf') asOf: unknown): Promise<CiRecord | null> {
    const args = parseInput(idSchema, { id, asOf }, 'ci arguments');
    return this.service.ci(this.tenant.tenantId, args.id, args.asOf ?? null);
  }

  @Query('cis')
  cis(
    @Args('filter') filter: unknown,
    @Args('first') first: unknown,
    @Args('after') after: unknown,
  ): Promise<Connection<CiRecord>> {
    const f = parseInput(ciFilterSchema.nullish(), filter, 'CiFilter') ?? {};
    const page = parseInput(pagingSchema, { first, after }, 'paging');
    return this.service.cis(
      this.tenant.tenantId,
      this.tenant.userId,
      f,
      page.first,
      page.after,
      this.tenant.loaders,
    );
  }

  @Query('unknownCis')
  unknownCis(@Args('first') first: unknown, @Args('after') after: unknown): Promise<Connection<CiRecord>> {
    const page = parseInput(pagingSchema, { first, after }, 'paging');
    return this.service.unknownCis(
      this.tenant.tenantId,
      this.tenant.userId,
      page.first,
      page.after,
      this.tenant.loaders,
    );
  }

  @Query('search')
  search(
    @Args('text') text: unknown,
    @Args('layers') layers: unknown,
    @Args('first') first: unknown,
  ): Promise<SearchHitRecord[]> {
    const args = parseInput(searchArgsSchema, { text, layers, first }, 'search arguments');
    return this.service.search(this.tenant.tenantId, args.text, args.layers ?? [], args.first);
  }

  @Query('vulnerabilities')
  vulnerabilities(
    @Args('minCvss') minCvss: unknown,
    @Args('internetFacing') internetFacing: unknown,
  ): Promise<VulnerabilityRecord[]> {
    const args = parseInput(vulnerabilityArgsSchema, { minCvss, internetFacing }, 'vulnerability arguments');
    return this.service.vulnerabilities(
      this.tenant.tenantId,
      args.minCvss ?? null,
      args.internetFacing ?? null,
    );
  }

  @Mutation('labelCi')
  @Roles(ROLES.operator)
  labelCi(@Args('input') input: unknown): Promise<CiRecord> {
    return this.service.labelCi(this.actor(), parseInput(labelCiSchema, input, 'LabelCiInput'));
  }

  @Mutation('updateCiAttributes')
  @Roles(ROLES.operator)
  updateCiAttributes(
    @Args('ciId') ciId: unknown,
    @Args('attributes') attributes: unknown,
  ): Promise<CiRecord> {
    const args = parseInput(updateAttributesSchema, { ciId, attributes }, 'updateCiAttributes arguments');
    return this.service.updateAttributes(this.actor(), args.ciId, args.attributes);
  }

  @Mutation('setCiCode')
  @Roles(ROLES.operator)
  setCiCode(@Args('ciId') ciId: unknown, @Args('code') code: unknown): Promise<CiRecord> {
    const args = parseInput(setCiCodeSchema, { ciId, code }, 'setCiCode arguments');
    return this.service.setCode(this.actor(), args.ciId, args.code);
  }

  @Mutation('setCiLifecycle')
  @Roles(ROLES.operator)
  setCiLifecycle(@Args('ciId') ciId: unknown, @Args('lifecycle') lifecycle: unknown): Promise<CiRecord> {
    const args = parseInput(setLifecycleSchema, { ciId, lifecycle }, 'setCiLifecycle arguments');
    return this.service.setLifecycle(this.actor(), args.ciId, args.lifecycle);
  }

  @Mutation('setCiTags')
  @Roles(ROLES.operator)
  setCiTags(@Args('ciId') ciId: unknown, @Args('tags') tags: unknown): Promise<CiRecord> {
    const args = parseInput(setTagsSchema, { ciId, tags }, 'setCiTags arguments');
    return this.service.setTags(this.actor(), args.ciId, args.tags);
  }

  @Query('ciTags')
  ciTags(@Args('limit') limit: unknown): Promise<Array<{ tag: string; count: number }>> {
    return this.service.tagCounts(this.tenant.tenantId, parseInput(tagListSchema, limit, 'ciTags limit') ?? CI_EDIT.tagListLimit);
  }

  @Mutation('createRelationship')
  @Roles(ROLES.operator)
  createRelationship(
    @Args('type') type: unknown,
    @Args('fromCiId') fromCiId: unknown,
    @Args('toCiId') toCiId: unknown,
    @Args('attributes') attributes: unknown,
  ): Promise<RelationshipRecord> {
    const args = parseInput(
      createRelationshipSchema,
      { type, fromCiId, toCiId, attributes },
      'createRelationship arguments',
    );
    return this.service.createRelationship(
      this.actor(),
      args.type,
      args.fromCiId,
      args.toCiId,
      args.attributes ?? {},
    );
  }

  @Mutation('retireRelationship')
  @Roles(ROLES.operator)
  retireRelationship(@Args('id') id: unknown): Promise<RelationshipRecord> {
    return this.service.retireRelationship(this.actor(), parseInput(uuidSchema, id, 'relationship id'));
  }

  private actor() {
    return {
      tenantId: this.tenant.tenantId,
      username: this.tenant.username,
      requestId: this.tenant.requestId,
    };
  }
}

@Resolver('Ci')
export class CiFieldsResolver {
  constructor(
    private readonly service: CiService,
    private readonly tenant: TenantContext,
  ) {}

  @ResolveField('health')
  async health(@Parent() ci: CiRecord): Promise<HealthState> {
    return (await this.tenant.loaders.health.load(ci.id)) ?? 'unknown';
  }

  /**
   * REQ-CMDB-038 — the layer's headline metric from ClickHouse. The unknown layer has no collector sampling it:
   * its headline is how many days ago discovery last saw the CI, derived here from observedAt.
   */
  @ResolveField('headlineMetric')
  async headlineMetric(@Parent() ci: CiRecord): Promise<HeadlineMetricRecord> {
    const spec = LAYER_HEADLINE_METRIC[ci.layer];
    const point = (await this.tenant.loaders.metrics.load(ci.id))?.get(spec.metric);
    if (point) return { ...spec, value: point.value, observedAt: point.observedAt };
    if (ci.layer === 'unknown') {
      const days = Math.max(0, Math.floor((Date.now() - Date.parse(ci.observedAt)) / TIME.msPerDay));
      return { ...spec, value: days, observedAt: ci.observedAt };
    }
    return { ...spec, value: null, observedAt: null };
  }

  @ResolveField('relationships')
  relationships(
    @Parent() ci: CiRecord,
    @Args('direction') direction: unknown,
    @Args('types') types: unknown,
    @Args('first') first: unknown,
    @Args('after') after: unknown,
  ): Promise<Connection<RelationshipRecord>> {
    const args = parseInput(
      relationshipArgsSchema,
      { direction, types, first, after },
      'relationships arguments',
    );
    return this.service.relationships(
      this.tenant.tenantId,
      ci.id,
      args.direction ?? 'both',
      args.types ?? [],
      args.first,
      args.after,
      null,
    );
  }

  @ResolveField('vulnerabilities')
  vulnerabilities(@Parent() ci: CiRecord): Promise<VulnerabilityRecord[]> {
    return this.service.vulnerabilitiesOf(this.tenant.tenantId, ci);
  }

  @ResolveField('history')
  history(
    @Parent() ci: CiRecord,
    @Args('from') from: unknown,
    @Args('to') to: unknown,
  ): Promise<CiVersionRecord[]> {
    const args = parseInput(historyArgsSchema, { from, to }, 'history arguments');
    return this.service.history(this.tenant.tenantId, ci.id, args.from ?? null, args.to ?? null);
  }
}

@Resolver('Relationship')
export class RelationshipFieldsResolver {
  constructor(private readonly tenant: TenantContext) {}

  @ResolveField('from')
  from(@Parent() rel: RelationshipRecord): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(rel.fromCiId);
  }

  @ResolveField('to')
  to(@Parent() rel: RelationshipRecord): Promise<CiRecord | null> {
    return this.tenant.loaders.ci.load(rel.toCiId);
  }
}
