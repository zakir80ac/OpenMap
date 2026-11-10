// REQ-INT-011 (ADR-072) — the nodes a configuration-management tool manages, read from the CMDB: current CIs of the
// inventory types (or the request's), filtered by layer, lifecycle, tag, site and business service. Each node carries
// the address to connect to (management IP, then FQDN, then primary IP), the site its located_in chain reaches (or the
// site its collector observed), the business services whose members reach it over compute edges, and the attributes the
// request asks for. CIs naming the same node (a host and its hypervisor share an FQDN) are merged into one.
import { Injectable } from '@nestjs/common';
import { INVENTORY } from '@openmap/constants';
import type { CiLayer, CiType, InventoryFacts } from '@openmap/contracts';
import { Prisma } from '@openmap/db';
import { withSpan } from '@openmap/telemetry';
import { PrismaService } from '../db/prisma.service.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import type { InventoryNode, VarValue } from './inventory.formats.js';

export interface InventoryFilter {
  types?: readonly CiType[] | undefined;
  layers?: readonly CiLayer[] | undefined;
  lifecycle?: readonly string[] | undefined;
  tags?: readonly string[] | undefined;
  /** Site codes, case-insensitive. */
  sites?: readonly string[] | undefined;
  /** Business services by id or code (case-insensitive). */
  services?: readonly string[] | undefined;
  /** Attribute keys copied into the facts; INVENTORY.defaultAttributes when absent. */
  attributes?: readonly string[] | undefined;
}

interface CiRow {
  id: string;
  code: string;
  name: string;
  type: string;
  layer: string;
  lifecycle: string;
  tags: string[];
  identity: Record<string, unknown>;
  attributes: Record<string, unknown>;
}

interface ServiceRef {
  id: string;
  code: string;
  name: string;
}

interface Membership {
  services: Map<string, ServiceRef>;
  /** CI id → ids of the services whose members reach it. */
  byCi: Map<string, string[]>;
}

/** Keys the service reads from identity and attributes besides the requested attributes. */
const SETTING_KEYS = [
  INVENTORY.puppetClassesAttribute,
  INVENTORY.puppetEnvironmentAttribute,
  INVENTORY.chefEnvironmentAttribute,
] as const;

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** An attribute as a variable: JSON scalars and arrays of them; nested objects are not CI attributes (ci.ts) and are dropped. */
function varValue(v: unknown): VarValue | undefined {
  if (isScalar(v)) return v;
  if (Array.isArray(v) && v.every(isScalar)) return v;
  return undefined;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** The first of the keys present, each read from identity before attributes. */
function firstOf(row: Pick<CiRow, 'identity' | 'attributes'>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = text(row.identity[key]) ?? text(row.attributes[key]);
    if (v !== null) return v;
  }
  return null;
}

/** The name a tool knows the node by: its FQDN in lower case (as Puppet certnames and Chef node names are), else the CI name. */
export function nodeName(row: Pick<CiRow, 'identity' | 'attributes' | 'name'>): string {
  const fqdn = firstOf(row, INVENTORY.nodeNameKeys);
  return fqdn === null ? row.name : fqdn.toLowerCase();
}

const TYPE_RANK = new Map<string, number>(INVENTORY.defaultTypes.map((t, i) => [t, i]));

function rank(row: CiRow): number {
  return TYPE_RANK.get(row.type) ?? INVENTORY.defaultTypes.length;
}

export interface NodeInput {
  row: CiRow;
  site: string | null;
  services: ServiceRef[];
}

/**
 * Folds the CIs into nodes by name: the CI of the earliest inventory type (then the lowest id) speaks for the node, the
 * others add their ids, tags, services and any attribute the first lacks. Nodes come back in name order.
 */
export function mergeNodes(inputs: readonly NodeInput[], attributeKeys: readonly string[]): InventoryNode[] {
  const byName = new Map<string, NodeInput[]>();
  for (const input of inputs) {
    const name = nodeName(input.row);
    const list = byName.get(name) ?? [];
    list.push(input);
    byName.set(name, list);
  }
  const nodes: InventoryNode[] = [];
  for (const [name, list] of byName) {
    const sorted = [...list].sort((a, b) => rank(a.row) - rank(b.row) || a.row.id.localeCompare(b.row.id));
    const first = sorted[0];
    if (first === undefined) continue;
    const attributes: Record<string, VarValue> = {};
    const settings: Record<string, VarValue> = {};
    const tags = new Set<string>();
    const services = new Map<string, ServiceRef>();
    let site: string | null = null;
    for (const { row, site: s, services: svc } of sorted) {
      for (const key of attributeKeys) {
        const v = varValue(row.attributes[key]);
        if (v !== undefined && !(key in attributes)) attributes[key] = v;
      }
      for (const key of SETTING_KEYS) {
        const v = varValue(row.attributes[key]);
        if (v !== undefined && !(key in settings)) settings[key] = v;
      }
      for (const t of row.tags) tags.add(t);
      for (const x of svc) services.set(x.id, x);
      site ??= s;
    }
    const facts: InventoryFacts = {
      id: first.row.id,
      mergedIds: sorted.slice(1).map((i) => i.row.id),
      code: first.row.code,
      name: first.row.name,
      type: first.row.type,
      layer: first.row.layer,
      lifecycle: first.row.lifecycle,
      site,
      tags: [...tags].sort(),
      services: [...services.values()].sort((a, b) => a.code.localeCompare(b.code)),
      attributes,
    };
    const address = sorted.map((i) => firstOf(i.row, INVENTORY.addressKeys)).find((a) => a !== null) ?? null;
    nodes.push({ name, address, facts, settings });
  }
  return nodes.sort((a, b) => a.name.localeCompare(b.name));
}

@Injectable()
export class InventoryService {
  /** Service membership per tenant, for INVENTORY.membershipCacheMs. */
  private readonly membershipCache = new Map<string, { at: number; value: Promise<Membership> }>();

  constructor(private readonly prisma: PrismaService) {}

  /** The nodes the filter selects, merged and in name order. */
  nodes(tenantId: string, filter: InventoryFilter): Promise<InventoryNode[]> {
    return withSpan(TRACER_NAME, 'inventory.nodes', { 'openmap.tenant': tenantId }, async (span) => {
      const t = Prisma.sql;
      const types = filter.types ?? INVENTORY.defaultTypes;
      const lifecycle = filter.lifecycle ?? INVENTORY.defaultLifecycle;
      const where: Prisma.Sql[] = [
        t`c.type::text = ANY(${[...types]}::text[])`,
        t`c.lifecycle::text = ANY(${[...lifecycle]}::text[])`,
      ];
      if (filter.layers !== undefined && filter.layers.length > 0)
        where.push(t`c.layer::text = ANY(${[...filter.layers]}::text[])`);
      if (filter.tags !== undefined && filter.tags.length > 0)
        where.push(t`c.tags @> ${[...filter.tags]}::text[]`);
      const nodes = await this.select(tenantId, Prisma.join(where, ' AND '), filter);
      span.setAttribute('openmap.inventory.nodes', nodes.length);
      return nodes;
    });
  }

  /** The node a Puppet agent's certname names: an inventory CI with that FQDN or name (case-insensitive), or null. */
  byCertname(
    tenantId: string,
    certname: string,
    attributes: readonly string[] | undefined,
  ): Promise<InventoryNode | null> {
    return withSpan(TRACER_NAME, 'inventory.certname', { 'openmap.tenant': tenantId }, async () => {
      const t = Prisma.sql;
      const wanted = certname.trim().toLowerCase();
      const names = INVENTORY.nodeNameKeys.flatMap((k) => [
        t`lower(c.identity->>${k}) = ${wanted}`,
        t`lower(c.attributes->>${k}) = ${wanted}`,
      ]);
      const where = Prisma.join(
        [
          t`c.type::text = ANY(${[...INVENTORY.defaultTypes]}::text[])`,
          t`c.lifecycle::text = ANY(${[...INVENTORY.defaultLifecycle]}::text[])`,
          t`(${Prisma.join([...names, t`lower(c.name) = ${wanted}`], ' OR ')})`,
        ],
        ' AND ',
      );
      const nodes = await this.select(tenantId, where, { attributes });
      return nodes.find((n) => n.name.toLowerCase() === wanted) ?? nodes[0] ?? null;
    });
  }

  /**
   * One statement: the CIs the filter selects, the nearest site CI up each one's located_in / runs_on / hosted_on chain
   * (else the site its collector observed), the site filter applied in SQL, and only then the identity and attribute
   * keys the formats read pulled out of the JSON columns, so a narrow inventory never reads the whole estate's attributes.
   */
  private async select(
    tenantId: string,
    where: Prisma.Sql,
    filter: InventoryFilter,
  ): Promise<InventoryNode[]> {
    const t = Prisma.sql;
    const attributeKeys = filter.attributes ?? INVENTORY.defaultAttributes;
    const identityKeys = [...new Set<string>([...INVENTORY.addressKeys, ...INVENTORY.nodeNameKeys])];
    const readKeys = [...new Set<string>([...attributeKeys, ...identityKeys, ...SETTING_KEYS])];
    const siteFilter =
      filter.sites !== undefined && filter.sites.length > 0
        ? t`WHERE lower(placed.site) = ANY(${filter.sites.map((x) => x.toLowerCase())}::text[])`
        : Prisma.empty;
    const rows = await this.prisma.client.$queryRaw<Array<CiRow & { site: string | null }>>(t`
      WITH RECURSIVE sel AS (
        SELECT c.id, NULLIF(c.attributes->>${INVENTORY.siteAttribute}, '') AS observed FROM cis c
        WHERE c."tenantId" = ${tenantId}::uuid AND c."validTo" IS NULL AND ${where}
      ), up AS (
        SELECT sel.id AS ci, sel.id AS at, 0 AS hop FROM sel
        UNION ALL
        SELECT up.ci, r."toCiId", up.hop + 1 FROM up
        JOIN relationships r ON r."fromCiId" = up.at AND r."tenantId" = ${tenantId}::uuid AND r."validTo" IS NULL
          AND r.type::text = ANY(${[...INVENTORY.siteEdges]}::text[])
        WHERE up.hop < ${INVENTORY.siteHops}
      ), chained AS (
        SELECT DISTINCT ON (up.ci) up.ci,
          COALESCE(NULLIF(s.identity->>${INVENTORY.siteCodeKey}, ''), NULLIF(s.attributes->>${INVENTORY.siteCodeKey}, ''), s.name) AS site
        FROM up JOIN cis s ON s.id = up.at AND s.type = 'site' AND s."validTo" IS NULL AND s."tenantId" = ${tenantId}::uuid
        ORDER BY up.ci, up.hop
      ), placed AS (
        SELECT sel.id, COALESCE(chained.site, sel.observed) AS site FROM sel LEFT JOIN chained ON chained.ci = sel.id
      )
      SELECT c.id::text AS id, c.code, c.name, c.type::text AS type, c.layer::text AS layer, c.lifecycle::text AS lifecycle, c.tags, placed.site,
        (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(c.identity) e WHERE e.key = ANY(${identityKeys}::text[])) AS identity,
        (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(c.attributes) e WHERE e.key = ANY(${readKeys}::text[])) AS attributes
      FROM (SELECT * FROM placed ${siteFilter}) placed JOIN cis c ON c.id = placed.id`);
    if (rows.length === 0) return [];
    const membership = await this.membership(tenantId);
    let inputs: NodeInput[] = rows.map(({ site, ...row }) => ({
      row,
      site,
      services: (membership.byCi.get(row.id) ?? []).flatMap((id) => {
        const svc = membership.services.get(id);
        return svc === undefined ? [] : [svc];
      }),
    }));
    if (filter.services !== undefined && filter.services.length > 0) {
      const wanted = new Set(filter.services.map((x) => x.toLowerCase()));
      inputs = inputs.filter((i) =>
        i.services.some((x) => wanted.has(x.id) || wanted.has(x.code.toLowerCase())),
      );
    }
    return mergeNodes(inputs, attributeKeys);
  }

  /** Which business services reach which CIs, walked down from every service's members, cached per tenant. */
  private membership(tenantId: string): Promise<Membership> {
    const now = Date.now();
    const hit = this.membershipCache.get(tenantId);
    if (hit !== undefined && now - hit.at < INVENTORY.membershipCacheMs) return hit.value;
    const value = this.loadMembership(tenantId);
    value.catch(() => this.membershipCache.delete(tenantId));
    this.membershipCache.set(tenantId, { at: now, value });
    if (this.membershipCache.size > INVENTORY.membershipCacheEntries) {
      const oldest = this.membershipCache.keys().next().value;
      if (oldest !== undefined) this.membershipCache.delete(oldest);
    }
    return value;
  }

  private loadMembership(tenantId: string): Promise<Membership> {
    return withSpan(TRACER_NAME, 'inventory.membership', { 'openmap.tenant': tenantId }, async (span) => {
      const [services, pairs] = await Promise.all([
        this.prisma.client.$queryRaw<ServiceRef[]>(Prisma.sql`
        SELECT id::text AS id, code, name FROM cis WHERE "tenantId" = ${tenantId}::uuid AND "validTo" IS NULL AND type = 'business_service'`),
        this.prisma.client.$queryRaw<Array<{ ci: string; service: string }>>(Prisma.sql`
        WITH RECURSIVE walk AS (
          SELECT r."toCiId" AS service, r."fromCiId" AS ci, 0 AS hop
          FROM relationships r JOIN cis s ON s.id = r."toCiId" AND s."validTo" IS NULL AND s.type = 'business_service'
          WHERE r."tenantId" = ${tenantId}::uuid AND r.type = 'part_of_service' AND r."validTo" IS NULL
          UNION
          SELECT w.service, r."toCiId", w.hop + 1 FROM walk w
          JOIN relationships r ON r."fromCiId" = w.ci AND r."validTo" IS NULL AND r.type::text = ANY(${[...INVENTORY.serviceEdges]}::text[])
          JOIN cis f ON f.id = w.ci AND f."validTo" IS NULL
            AND (r.type <> 'contains' OR f.type::text = ANY(${[...INVENTORY.serviceContainerTypes]}::text[]))
          WHERE w.hop < ${INVENTORY.serviceHops}
        )
        SELECT DISTINCT ci::text AS ci, service::text AS service FROM walk`),
      ]);
      const byCi = new Map<string, string[]>();
      for (const p of pairs) {
        const list = byCi.get(p.ci) ?? [];
        list.push(p.service);
        byCi.set(p.ci, list);
      }
      span.setAttribute('openmap.inventory.memberships', pairs.length);
      return { services: new Map(services.map((s) => [s.id, s])), byCi };
    });
  }
}
