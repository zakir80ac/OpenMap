// REQ-CORE-019 (ADR-049) — REST v1: every route of the contract's REST_ROUTES table, validated against the table's
// schemas and served by the services GraphQL uses (no logic of its own). Tenant and user come from the bearer token;
// writes need the operator role. Each call is counted and timed by route and status and runs in a rest.<route> span.
// GET /api/v1/openapi.json is public: tools discover the API before they authenticate.
import { randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { openApiDocument, REST_ROUTES, type RestRouteId } from '@openmap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { Principal } from '../auth/principal.js';
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { ROLES } from '../auth/roles.js';
import { CiService, type Actor } from '../ci/ci.service.js';
import type { CiRecord, Connection, RelationshipRecord, SearchHitRecord } from '../ci/ci.types.js';
import { ConnectivityService } from '../connectivity/connectivity.service.js';
import { GraphQueryService } from '../graph/graph.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { ServicesService } from '../services/services.service.js';
import type { IncidentRecord } from '../services/services.types.js';
import { parse, runRoute, type BodyOf, type QueryOf } from './rest-route.js';

function page<T>(c: Connection<T>): { items: T[]; pageInfo: Connection<T>['pageInfo']; totalCount: number } {
  return { items: c.edges.map((e) => e.node), pageInfo: c.pageInfo, totalCount: c.totalCount };
}

@Controller('api/v1')
export class RestController {
  constructor(
    private readonly cis: CiService,
    private readonly graph: GraphQueryService,
    private readonly services: ServicesService,
    private readonly connectivity: ConnectivityService,
    private readonly metrics: MetricsService,
  ) {}

  /** Runs one route in its span, counting and timing it by route id and outcome status (rest-route.ts). */
  private run<T>(route: RestRouteId, request: AuthenticatedRequest, work: (principal: Principal) => Promise<T>): Promise<T> {
    return runRoute(this.metrics, route, request, work);
  }

  private actor(p: Principal, request: AuthenticatedRequest): Actor {
    return { tenantId: p.tenantId, username: p.username, requestId: typeof request.id === 'string' && request.id !== '' ? request.id : randomUUID() };
  }

  @Public()
  @Get('openapi.json')
  openapi(): Record<string, unknown> {
    return openApiDocument(CONTRACT_VERSIONS.rest);
  }

  @Get('cis')
  listCis(@Query() raw: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    return this.run('listCis', request, async (p) => {
      const q: QueryOf<'listCis'> = parse(REST_ROUTES.listCis.query, raw, 'query');
      const filter = { types: q.types, layers: q.layers, lifecycle: q.lifecycle, health: q.health, tags: q.tags, text: q.text };
      return page(await this.cis.cis(p.tenantId, p.subject, filter, q.first ?? null, q.after ?? null, null));
    });
  }

  @Get('cis/:id')
  getCi(@Param() params: unknown, @Query() raw: unknown, @Req() request: AuthenticatedRequest): Promise<CiRecord> {
    return this.run('getCi', request, async (p) => {
      const { id } = parse(REST_ROUTES.getCi.params, params, 'path');
      const q: QueryOf<'getCi'> = parse(REST_ROUTES.getCi.query, raw, 'query');
      const ci = await this.cis.ci(p.tenantId, id, q.asOf ?? null);
      if (ci === null) throw new NotFoundException('CI ' + id + ' not found');
      return ci;
    });
  }

  @Patch('cis/:id/attributes')
  @Roles(ROLES.operator)
  patchCiAttributes(@Param() params: unknown, @Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<CiRecord> {
    return this.run('patchCiAttributes', request, async (p) => {
      const { id } = parse(REST_ROUTES.patchCiAttributes.params, params, 'path');
      const b: BodyOf<'patchCiAttributes'> = parse(REST_ROUTES.patchCiAttributes.body, body, 'body');
      return this.cis.updateAttributes(this.actor(p, request), id, b.attributes);
    });
  }

  @Get('cis/:id/relationships')
  listCiRelationships(@Param() params: unknown, @Query() raw: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    return this.run('listCiRelationships', request, async (p) => {
      const { id } = parse(REST_ROUTES.listCiRelationships.params, params, 'path');
      const q: QueryOf<'listCiRelationships'> = parse(REST_ROUTES.listCiRelationships.query, raw, 'query');
      await this.cis.requireCi(p.tenantId, id);
      return page(await this.cis.relationships(p.tenantId, id, q.direction ?? 'both', q.types ?? [], q.first ?? null, q.after ?? null, null));
    });
  }

  @Get('cis/:id/impact')
  getCiImpact(@Param() params: unknown, @Query() raw: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    return this.run('getCiImpact', request, async (p) => {
      const { id } = parse(REST_ROUTES.getCiImpact.params, params, 'path');
      const q: QueryOf<'getCiImpact'> = parse(REST_ROUTES.getCiImpact.query, raw, 'query');
      const r = await this.graph.impact(p.tenantId, id, q.direction ?? 'upstream', q.maxDepth ?? 0, null);
      const cis = new Map((await this.cis.byIds(p.tenantId, r.nodes.map((n) => n.ciId))).map((c) => [c.id, c]));
      return { root: r.root, nodes: r.nodes.flatMap((n) => { const ci = cis.get(n.ciId); return ci === undefined ? [] : [{ ci, depth: n.depth, predicted: n.predicted, path: n.path }]; }), services: r.services.map((s) => ({ service: s.service, tier: s.tier, predicted: s.predicted, path: s.path })), durationMs: r.durationMs };
    });
  }

  @Post('relationships')
  @Roles(ROLES.operator)
  @HttpCode(REST_ROUTES.createRelationship.status)
  createRelationship(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<RelationshipRecord> {
    return this.run('createRelationship', request, async (p) => {
      const b: BodyOf<'createRelationship'> = parse(REST_ROUTES.createRelationship.body, body, 'body');
      return this.cis.createRelationship(this.actor(p, request), b.type, b.fromCiId, b.toCiId, b.attributes ?? {});
    });
  }

  @Delete('relationships/:id')
  @Roles(ROLES.operator)
  retireRelationship(@Param() params: unknown, @Req() request: AuthenticatedRequest): Promise<RelationshipRecord> {
    return this.run('retireRelationship', request, async (p) => {
      const { id } = parse(REST_ROUTES.retireRelationship.params, params, 'path');
      return this.cis.retireRelationship(this.actor(p, request), id);
    });
  }

  @Get('search')
  search(@Query() raw: unknown, @Req() request: AuthenticatedRequest): Promise<SearchHitRecord[]> {
    return this.run('search', request, async (p) => {
      const q: QueryOf<'search'> = parse(REST_ROUTES.search.query, raw, 'query');
      return this.cis.search(p.tenantId, q.q, q.layers ?? [], q.first ?? null);
    });
  }

  @Get('incidents')
  listIncidents(@Query() raw: unknown, @Req() request: AuthenticatedRequest): Promise<IncidentRecord[]> {
    return this.run('listIncidents', request, async (p) => {
      const q: QueryOf<'listIncidents'> = parse(REST_ROUTES.listIncidents.query, raw, 'query');
      return this.services.incidents(p.tenantId, q.open !== 'false', q.serviceId ?? null);
    });
  }

  @Get('connectivity')
  getConnectivity(@Req() request: AuthenticatedRequest): Promise<unknown> {
    return this.run('getConnectivity', request, async (p) => {
      const c = await this.connectivity.connectivity(p.tenantId);
      return {
        sites: c.sites.map(({ ci, ...s }) => ({ ciId: ci.id, name: ci.displayName, ...s })),
        links: c.links.map((l) => ({ ciId: l.ci.id, name: l.ci.displayName, fromSite: l.fromSite, toSite: l.toSite, replication: l.replication, probeTarget: l.probeTarget, reachable: l.reachable, latencyMs: l.latencyMs, lossPercent: l.lossPercent, probedAt: l.probedAt, provider: l.provider, capacityMbps: l.capacityMbps, throughputMbps: l.throughputMbps, utilisationPercent: l.utilisationPercent, redundancy: l.redundancy })),
        findings: c.findings,
      };
    });
  }
}
