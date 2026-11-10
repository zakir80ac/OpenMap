// REQ-INT-011 (ADR-072) — REST v1 dynamic inventory for configuration-management tools, routes of the contract's
// REST_ROUTES table: GET /api/v1/inventory/ansible (dynamic-inventory JSON), /salt (salt-ssh roster), /puppet and
// /puppet/nodes/{certname} (ENC documents), /chef (node and role JSON for knife). Authenticated like every REST route:
// a person's token or an automation client's (client-credentials) token; any signed-in role reads. The roster and the
// ENC answer YAML unless `format=json`. Each call counts one document and its nodes by tool, beside the REST counters.
import { Controller, Get, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import {
  DEFAULT_INVENTORY_FACETS,
  INVENTORY_MEDIA_TYPES,
  REST_ROUTES,
  type InventoryDocumentFormat,
} from '@openmap/contracts';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import {
  ansibleInventory,
  chefExport,
  puppetNode,
  puppetNodes,
  saltRoster,
} from '../inventory/inventory.formats.js';
import { InventoryService, type InventoryFilter } from '../inventory/inventory.service.js';
import { toYaml } from '../inventory/yaml.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { parse, runRoute, type QueryOf } from './rest-route.js';

type Tool = 'ansible' | 'salt' | 'puppet' | 'chef';

function filterOf(
  q: QueryOf<'ansibleInventory'> | QueryOf<'saltRoster'> | QueryOf<'puppetNodes'> | QueryOf<'chefExport'>,
): InventoryFilter {
  return {
    types: q.types,
    layers: q.layers,
    lifecycle: q.lifecycle,
    tags: q.tags,
    sites: q.sites,
    services: q.services,
    attributes: q.attributes,
  };
}

@Controller('api/v1/inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly metrics: MetricsService,
  ) {}

  private served(tool: Tool, nodes: number): void {
    this.metrics.inventoryExports.inc({ tool });
    this.metrics.inventoryNodes.inc({ tool }, nodes);
  }

  /** YAML (the tools' own format) unless JSON was asked for; JSON goes through Nest's serialiser as every route does. */
  private document(
    reply: FastifyReply,
    format: InventoryDocumentFormat | undefined,
    value: unknown,
  ): unknown {
    if (format === 'json') return value;
    void reply.header('content-type', INVENTORY_MEDIA_TYPES.yaml + '; charset=utf-8');
    return toYaml(value);
  }

  @Get('ansible')
  ansible(@Query() raw: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    return runRoute(this.metrics, 'ansibleInventory', request, async (p) => {
      const q: QueryOf<'ansibleInventory'> = parse(REST_ROUTES.ansibleInventory.query, raw, 'query');
      const nodes = await this.inventory.nodes(p.tenantId, filterOf(q));
      this.served('ansible', nodes.length);
      return ansibleInventory(nodes, q.groupBy ?? DEFAULT_INVENTORY_FACETS);
    });
  }

  @Get('salt')
  salt(
    @Query() raw: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    return runRoute(this.metrics, 'saltRoster', request, async (p) => {
      const q: QueryOf<'saltRoster'> = parse(REST_ROUTES.saltRoster.query, raw, 'query');
      const nodes = await this.inventory.nodes(p.tenantId, filterOf(q));
      this.served('salt', nodes.length);
      const roster = saltRoster(nodes, {
        ...(q.user === undefined ? {} : { user: q.user }),
        ...(q.port === undefined ? {} : { port: q.port }),
        ...(q.sudo === undefined ? {} : { sudo: q.sudo === 'true' }),
      });
      return this.document(reply, q.format, roster);
    });
  }

  @Get('puppet')
  puppet(
    @Query() raw: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    return runRoute(this.metrics, 'puppetNodes', request, async (p) => {
      const q: QueryOf<'puppetNodes'> = parse(REST_ROUTES.puppetNodes.query, raw, 'query');
      const nodes = await this.inventory.nodes(p.tenantId, filterOf(q));
      this.served('puppet', nodes.length);
      return this.document(reply, q.format, puppetNodes(nodes, q.environment ?? null));
    });
  }

  @Get('puppet/nodes/:certname')
  puppetNode(
    @Param() params: unknown,
    @Query() raw: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    return runRoute(this.metrics, 'puppetNode', request, async (p) => {
      const { certname } = parse(REST_ROUTES.puppetNode.params, params, 'path');
      const q: QueryOf<'puppetNode'> = parse(REST_ROUTES.puppetNode.query, raw, 'query');
      const node = await this.inventory.byCertname(p.tenantId, certname, q.attributes);
      if (node === null) throw new NotFoundException('no inventory CI has certname ' + certname);
      this.served('puppet', 1);
      return this.document(reply, q.format, puppetNode(node, q.environment ?? null));
    });
  }

  @Get('chef')
  chef(@Query() raw: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    return runRoute(this.metrics, 'chefExport', request, async (p) => {
      const q: QueryOf<'chefExport'> = parse(REST_ROUTES.chefExport.query, raw, 'query');
      const nodes = await this.inventory.nodes(p.tenantId, filterOf(q));
      this.served('chef', nodes.length);
      return chefExport(nodes, q.environment ?? null);
    });
  }
}
